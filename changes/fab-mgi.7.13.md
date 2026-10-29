- Talks in the app (spec §15.3, §15.4, §18.3, §18.4): the console's talk panel holds the scope's run talk,
  opened as a project is selected, its header giving the talk's model and context use
  (`claude-opus-5-5 · 14k ctx`), its messages bottom-aligned and its composer sending to it. When questions
  in scope are open and their project's `questions` setting is `auto`, the answer talk takes the panel by
  itself without taking focus, and the run talk comes back once they are answered; with `key`, the panel's
  "Answer talk" button or the key A opens it. Under All projects a message goes to the run talk of the
  project it names, or the panel asks which. The Talks screen starts refine talks (on a spec's path) and
  feature talks on the scoped project and shows one full height, beside the console's run and answer talks;
  "Talk it through" opens the answer talk there.
