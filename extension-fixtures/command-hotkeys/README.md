# Command and keybinding conformance fixture

This fixture targets VLO SDK `>=1.7.0`. It proves the `api.ui.commands`
surface end to end:

- a declarative command (`bump-counter`) gated on the `project.open` context
  key;
- a working keybinding (`Mod+Alt+B`) dispatched through the host chord table;
- a deliberately colliding keybinding (`Mod+Z`, a host default) that must
  register **inactive with a diagnostic** rather than fail activation or
  double-fire behind the host handler;
- a `timeline.clip.context` menu item that invokes the command through
  `commands.execute` with the clicked clip as subject;
- full cleanup of all registrations on deactivation.

This is a conformance package; real extensions should not bind chords they
know the host owns.
