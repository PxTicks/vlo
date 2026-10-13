::include{src="shared:minimax/prompting-reference.md"}

### Editing a still from a reference

The source image is the generation's only reference, `Picture 1`, so write the
prompt as a **full-reference** block and let the picture be drawn rather than
continued: `subject_definitions` says what the reference provides,
`detailed_description` describes the picture itself — composition, subject,
lighting and the change — and `overall_soundscape` and `non_diegetic_music` are
`N/A` for a still.

- `MiniMax H3 Image Edit (Reference)` pins **Length** to 5 frames, the shortest
  count on H3's `17k+5` grid. Five pixel frames pack into two latent frames, and
  nothing past them would be kept, so a longer clip only costs time.
- **Result frame** chooses which latent frame becomes the picture. `0`, the
  default, is the generated picture; `1` is a frame of motion further on.
- **Reference image size** trades fidelity for time: `match` fits the reference
  to the generation's pixel area, `max` keeps the reference pipeline's 2048px
  short edge.

For the same idea with the source attached as the *first frame* instead of as a
reference, see **MiniMax H3 Image Edit**.
