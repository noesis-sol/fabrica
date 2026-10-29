// The RPC server (spec §8.1, §8.2, §9.3): the protocol on the engine's local socket and its TLS
// listener, one handler layer per group.
export { attentionHandlers } from './attention'
export { backlogHandlers } from './backlog'
export {
  CertificateFailed,
  type CertificateFiles,
  type TlsCertificate,
  engineCertificate,
  makeSelfSigned,
  readCertificate,
  tlsCertificate,
} from './certificate'
export { engineHandlers } from './engine'
export { insightsHandlers } from './insights'
export { NotImplemented, notImplemented } from './not-implemented'
export { projectsHandlers } from './projects'
export { reviewHandlers } from './review'
export { runsHandlers } from './runs'
export { secretsHandlers } from './secrets'
export { localRpcServer, protocolHandlers, removeStaleSocket } from './server'
export { talksHandlers } from './talks'
export {
  ListenFailed,
  type TlsEndpoint,
  type TlsListener,
  listenTls,
} from './tls'
export {
  PairingTokens,
  type PairingTokensShape,
  pairingTokensLayer,
  tokensHandlers,
} from './tokens'
export { workersHandlers } from './workers'
