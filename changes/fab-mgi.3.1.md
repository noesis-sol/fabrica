- `packages/contracts` has the ticket model (spec §11.2): `Ticket` with its type, status, resolution, priority
  0–4, deferral, `Assignee`, model override, `TicketMetadata` (files, spec, predicted_files, result_kind, and
  any other keys kept), `TicketResult` (the typed hand-offs of §13.5, one case per `ResultKind`) and
  `Question` (2 to 4 options, one recommended, consequential and maintainer-only flags, the answer); `Label`,
  `Edge`, `Note`, `TicketEvent` with its `TicketChange`, and `Actor`. `NoteId` joins the branded IDs.
