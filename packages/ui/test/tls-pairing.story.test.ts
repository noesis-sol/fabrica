import { Option, Redacted } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  label,
  role,
  scene,
  text,
  type,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineAddress,
  FingerprintAnswer,
  KeepAnswer,
  KnownEngine,
  PairAnswer,
} from '@fabrica/client'
import { EngineId, protocolVersion } from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import * as RemoteEngines from '../src/app/remote-engines'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// Pairing with an engine over TLS from the Engines screen (spec §9.1, §9.3): Add engine takes the
// engine's TLS address and a pairing token, the app reads the fingerprint of the certificate the engine
// presents and shows it, and only once the user accepts it is the pairing handed to the app; the engine
// then joins the known engines with that fingerprint pinned, is connected to, and is kept once its first
// hello comes. A paired engine whose certificate changed, or whose token was refused, stops, saying so,
// and is offered pairing again.

const flags = { platform: 'darwin' as const, release: '0.2.0' }
const start: Model = initialModel(flags)

const endpoint = { host: 'build-box', port: 8443 }
const fingerprint = Array.from({ length: 32 }, () => '5E').join(':')
const renewed = Array.from({ length: 32 }, () => 'A7').join(':')
const token = Redacted.make('fab_token')
const address = EngineAddress.cases.Tls.make({ ...endpoint, fingerprint })

const engineMessage = (message: Engines.Message) =>
  Message.GotEnginesMessage({ message })

const pairingOf = (shown: Engines.Model): Engines.PairStep =>
  Engines.EngineSetup.match(shown.engineSetup, {
    Pairing: ({ step }) => step,
    Closed: () => expect.unreachable('the setup is closed'),
    Editing: () => expect.unreachable('the SSH form is being typed'),
    EditingTls: () => expect.unreachable('the TLS form is being typed'),
    Running: () => expect.unreachable('a host is being set up'),
    Wsl: () => expect.unreachable('a WSL2 distribution is being found'),
  })

describe('Add engine over TLS', () => {
  test('reads the engine’s certificate, and pairs only once the user accepts its fingerprint', () => {
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.OpenedAddEngine()),
      message(Engines.Message.ChoseTlsEngine()),
      message(Engines.Message.ChangedEngineAddress({ address: 'build-box' })),
      message(Engines.Message.SubmittedAddEngine()),
      Command.expectNone(),
      model(shown => {
        expect(shown.engineSetup).toMatchObject({
          _tag: 'EditingTls',
          problem: Option.some(
            'Give the engine’s TLS address, host:port, as fabrica engine status prints it on its host.',
          ),
        })
      }),
      message(
        Engines.Message.ChangedEngineAddress({ address: ' build-box:8443 ' }),
      ),
      message(
        Engines.Message.ChangedEngineToken({ token: Redacted.make('  ') }),
      ),
      message(Engines.Message.SubmittedAddEngine()),
      Command.expectNone(),
      model(shown => {
        expect(shown.engineSetup).toMatchObject({
          problem: Option.some(
            'Give a pairing token: fabrica token create makes one on the engine’s host.',
          ),
        })
      }),
      message(
        Engines.Message.ChangedEngineToken({
          token: Redacted.make(' fab_token '),
        }),
      ),
      message(Engines.Message.SubmittedAddEngine()),
      Command.resolve(
        Engines.ReadFingerprint({ endpoint }),
        Engines.Message.CompletedFingerprintRead({
          endpoint,
          answer: FingerprintAnswer.cases.Presented.make({ fingerprint }),
        }),
      ),
      model(shown => {
        // Named after its host, where no name was given.
        expect(shown.engineSetup).toMatchObject({
          _tag: 'Pairing',
          name: 'build-box',
          endpoint,
        })
        expect(pairingOf(shown)).toEqual(Engines.PairStep.Read({ fingerprint }))
        // Nothing joins the known engines before the user accepts.
        expect(
          Engines.remoteAfter(
            shown,
            Engines.Message.CompletedPairing({
              name: 'build-box',
              answer: PairAnswer.cases.Paired.make({}),
            }),
          ),
        ).toEqual(Option.none())
      }),
      message(Engines.Message.AcceptedFingerprint()),
      Command.expectExact(
        Engines.PairEngine({
          name: 'build-box',
          endpoint,
          fingerprint,
          token,
        }),
      ),
      model(shown => {
        expect(pairingOf(shown)).toEqual(
          Engines.PairStep.Pairing({ fingerprint }),
        )
        // A pairing under way is never interrupted.
        expect(
          Engines.update(shown, Engines.Message.ClosedEngineSetup()).model,
        ).toBe(shown)
        expect(
          Engines.remoteAfter(
            shown,
            Engines.Message.CompletedPairing({
              name: 'build-box',
              answer: PairAnswer.cases.Paired.make({}),
            }),
          ),
        ).toEqual(
          Option.some(
            Engines.RemoteChange.Added({ name: 'build-box', address }),
          ),
        )
      }),
      Command.resolve(
        Engines.PairEngine,
        Engines.Message.CompletedPairing({
          name: 'build-box',
          answer: PairAnswer.cases.Paired.make({}),
        }),
      ),
      model(shown => {
        expect(pairingOf(shown)).toEqual(
          Engines.PairStep.Paired({ fingerprint }),
        )
      }),
      message(Engines.Message.ClosedEngineSetup()),
      model(shown => {
        expect(shown.engineSetup).toEqual(Engines.EngineSetup.Closed())
      }),
    )
  })

  test('says why the certificate couldn’t be read, or the pairing wasn’t taken, and reads it again', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        engineSetup: Engines.EngineSetup.Pairing({
          name: 'build-box',
          endpoint,
          token,
          step: Engines.PairStep.Reading(),
        }),
      }),
      message(
        Engines.Message.CompletedFingerprintRead({
          endpoint,
          answer: FingerprintAnswer.cases.Failed.make({
            reason: 'no engine answered at build-box:8443 within 15s',
          }),
        }),
      ),
      model(shown => {
        expect(pairingOf(shown)).toEqual(
          Engines.PairStep.Failed({
            reason: 'no engine answered at build-box:8443 within 15s',
          }),
        )
      }),
      message(Engines.Message.RetriedFingerprintRead()),
      Command.resolve(
        Engines.ReadFingerprint({ endpoint }),
        Engines.Message.CompletedFingerprintRead({
          endpoint,
          answer: FingerprintAnswer.cases.Presented.make({ fingerprint }),
        }),
      ),
      message(Engines.Message.AcceptedFingerprint()),
      Command.resolve(
        Engines.PairEngine,
        Engines.Message.CompletedPairing({
          name: 'build-box',
          answer: PairAnswer.cases.Failed.make({
            reason:
              "the app can't keep the pairing token: no keyring is running",
          }),
        }),
      ),
      model(shown => {
        expect(pairingOf(shown)).toEqual(
          Engines.PairStep.Failed({
            reason:
              "the app can't keep the pairing token: no keyring is running",
          }),
        )
      }),
    )
  })

  test('gives an engine already paired at that address its name, and refuses another’s name', () => {
    const known: ReadonlyArray<RemoteEngines.RemoteEngine> = [
      {
        name: 'build-box',
        address,
        kept: Option.none(),
        attempt: 1,
        connection: Connection.Connecting(),
      },
    ]
    const editing = (address: string, name: string) => ({
      ...Engines.init(),
      engineSetup: Engines.EngineSetup.EditingTls({
        address,
        token,
        name,
        problem: Option.none(),
      }),
    })
    expect(
      Engines.update(
        editing('build-box:8443', 'other-name'),
        Engines.Message.SubmittedAddEngine(),
        known,
      ).model.engineSetup,
    ).toMatchObject({ _tag: 'Pairing', name: 'build-box' })
    expect(
      Engines.update(
        editing('10.0.0.9:8443', 'build-box'),
        Engines.Message.SubmittedAddEngine(),
        known,
      ).model.engineSetup,
    ).toMatchObject({
      _tag: 'EditingTls',
      problem: Option.some(
        'build-box names another of the app’s engines: give this one another name.',
      ),
    })
  })
})

describe('an engine paired over TLS', () => {
  const paired: Model = {
    ...start,
    screen: Screen.Engines(),
    screens: {
      ...start.screens,
      engines: {
        ...start.screens.engines,
        engineSetup: Engines.EngineSetup.Pairing({
          name: 'build-box',
          endpoint,
          token,
          step: Engines.PairStep.Pairing({ fingerprint }),
        }),
      },
    },
  }

  test('joins the known engines with its fingerprint pinned, and is kept once its first hello comes', () => {
    story(
      update,
      given(paired),
      message(
        engineMessage(
          Engines.Message.CompletedPairing({
            name: 'build-box',
            answer: PairAnswer.cases.Paired.make({}),
          }),
        ),
      ),
      model(shown => {
        expect(RemoteEngines.attempts(shown.remotes)).toEqual([
          { name: 'build-box', address, attempt: 1 },
        ])
      }),
      message(
        Message.ConnectedToRemote({
          name: 'build-box',
          engine: EngineId.make('e-build-box'),
          release: '0.2.0',
          protocol: protocolVersion,
        }),
      ),
      Command.resolve(
        RemoteEngines.KeepEngine({
          engine: KnownEngine.make({
            name: 'build-box',
            address,
            engine: EngineId.make('e-build-box'),
            protocol: protocolVersion,
          }),
        }),
        Message.CompletedKeepEngine({
          name: 'build-box',
          answer: KeepAnswer.cases.Kept.make({}),
        }),
      ),
    )
  })

  test('paired again with a new certificate is reached at it, and kept again', () => {
    const known = RemoteEngines.connected(
      RemoteEngines.added(RemoteEngines.init(), { name: 'build-box', address }),
      {
        name: 'build-box',
        hello: Connection.Up({
          engine: EngineId.make('e-build-box'),
          release: '0.2.0',
          protocol: protocolVersion,
        }),
      },
    ).model
    const moved = EngineAddress.cases.Tls.make({
      ...endpoint,
      fingerprint: renewed,
    })
    const again = RemoteEngines.added(known, {
      name: 'build-box',
      address: moved,
    })
    expect(RemoteEngines.attempts(again)).toEqual([
      { name: 'build-box', address: moved, attempt: 2 },
    ])
    expect(
      Option.map(RemoteEngines.named(again, 'build-box'), e => e.kept),
    ).toEqual(Option.some(Option.none()))
    // The same pairing again keeps what was kept.
    expect(
      Option.map(
        RemoteEngines.named(
          RemoteEngines.added(known, { name: 'build-box', address }),
          'build-box',
        ),
        e => Option.isSome(e.kept),
      ),
    ).toEqual(Option.some(true))
  })

  test('whose token was refused says so, and offers pairing again', () => {
    const refusal =
      'the engine refused the pairing token (HTTP 401): it is wrong, or was revoked; pair the engine again with a new token'
    const stopped: Model = {
      ...start,
      screen: Screen.Engines(),
      remotes: RemoteEngines.connectionChanged(
        RemoteEngines.added(RemoteEngines.init(), {
          name: 'build-box',
          address,
        }),
        'build-box',
        Connection.Stopped({ reason: refusal }),
      ),
    }
    scene(
      { update, view },
      givenScene(stopped),
      expectScene(
        within(role('article', { name: 'Engine build-box' }), text(refusal)),
      ).toExist(),
      expectScene(
        within(
          role('article', { name: 'Engine build-box' }),
          text('build-box:8443'),
        ),
      ).toExist(),
      click(role('button', { name: 'Pair again' })),
      expectScene(label('TLS address')).toHaveValue('build-box:8443'),
      expectScene(label('Name')).toHaveValue('build-box'),
      type(label('Pairing token'), 'fab_new'),
      click(role('button', { name: 'Read its certificate' })),
      SceneCommand.resolve(
        Engines.ReadFingerprint({ endpoint }),
        Engines.Message.CompletedFingerprintRead({
          endpoint,
          answer: FingerprintAnswer.cases.Presented.make({
            fingerprint: renewed,
          }),
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine at build-box:8443' }),
          label('Certificate fingerprint'),
        ),
      ).toHaveText(`SHA-256 ${renewed}`),
      click(role('button', { name: 'Accept and pair' })),
      SceneCommand.expectExact(
        Engines.PairEngine({
          name: 'build-box',
          endpoint,
          fingerprint: renewed,
          token: Redacted.make('fab_new'),
        }),
      ),
      SceneCommand.resolve(
        Engines.PairEngine,
        Engines.Message.CompletedPairing({
          name: 'build-box',
          answer: PairAnswer.cases.Paired.make({}),
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine at build-box:8443' }),
          role('status'),
        ),
      ).toHaveText(
        'Paired with build-box: the app reaches it at build-box:8443 while it presents this certificate, and keeps its token once it answers.',
      ),
    )
  })
})
