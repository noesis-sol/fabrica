- A run gives the merge queue's hand-backs to its workers: a conflict or a merge check failing in the
  ticket's own code resumes the session its dispatch saved, on the model that wrote it, with the hand-back's
  prompt, under the run's supervision; a turn refused at the usage limit ends there once the run holds,
  and a hand-back's closing message is noted on its ticket. Before, every hand-back set its ticket aside.
  The hand-backs' time limit counts time awake.
