::include{src="shared:minimax/prompting-base.md"}

### Editing a still

The source image is the generation's first frame, so write the prompt as an
**I2VA** block: the fixed first-frame instruction line, then the picture you
want at the end of the generation. Describe the source's style, subjects and
composition, then the change, and finish on the result — that last state is the
frame vlo keeps.

- `MiniMax H3 Image Edit` pins **Length** to 5 frames, the shortest count on
  H3's `17k+5` grid. Five pixel frames pack into two latent frames, and nothing
  past them would be kept, so a longer clip only costs time.
- **Result frame** chooses which latent frame becomes the picture. `0` is the
  source frame; `1`, the default, is the edit.

For the same idea with the source attached as a *reference* instead of as the
first frame, see **MiniMax H3 Image Edit (Reference)**.
