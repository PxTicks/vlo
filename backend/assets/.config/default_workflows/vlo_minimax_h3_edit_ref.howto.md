::include{src="shared:minimax/prompting-reference.md"}

### Editing a still from a reference

The source image is the generation's first reference, `Picture 1`, so write the
prompt as a **full-reference** block and let the picture be drawn rather than
continued: `subject_definitions` says what the reference provides,
`detailed_description` describes the picture itself — composition, subject,
lighting and the change — and `overall_soundscape` and `non_diegetic_music` are
`N/A` for a still.

- Add further images to the same input to cite them as `<Picture 2>`,
  `<Picture 3>` and so on — references are numbered in the order they are
  listed, and the first image frames the generation.
- `MiniMax H3 Image Edit (Reference)` pins **Length** to 5 frames, the shortest
  count on H3's `17k+5` grid. Five pixel frames pack into two latent frames, and
  nothing past them would be kept, so a longer clip only costs time.
- The frame kept is fixed at latent frame `0`: the causal first frame, which is
  the picture the prompt asks for and the one frame the decode is exact for.
- **Reference image size** trades fidelity for time: `match` fits each reference
  to the generation's pixel area, `max` keeps the reference pipeline's 2048px
  short edge.

For the same idea with the source attached as the *first frame* instead of as a
reference, see **MiniMax H3 Image Edit**.
