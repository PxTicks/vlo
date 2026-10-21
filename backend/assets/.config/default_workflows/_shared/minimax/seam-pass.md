### Seam pass

The first pass generates the masked area next to finished content it can only
see from one side, so a visible seam can form at the mask edge. The seam pass
then regenerates a narrow band across that edge, with everything outside the
band held, so the band has finished content on both sides to join. It is off by
default; turning it on adds a few turbo steps and needs the turbo LoRA.

The band is measured from the edge the first pass actually generated. The model
works in 16 px blocks paired into 32 px tokens, so that edge can sit up to one
token outside your mask.

In **Advanced Settings ▸ Seam pass**:

- **Run seam pass** turns the pass on. Toggle it with the same seed to compare.
- **Band into kept area** (16 px by default) and **Band into generated area**
  (64 px by default) set how far the band reaches on each side of that edge,
  in 16 px steps. Even steps keep the band edge on whole tokens; the 16 px
  default puts the kept-side edge mid-token.
- **Seam pass denoise** sets how much the band may change. MiniMax H3's schedule
  is strongly shifted, so low values only touch up texture; 1.0 regenerates the
  band outright.
- **Seam pass steps** is 4 by default, which suits the turbo LoRA.
- **Seam pass LoRA** is the MiniMax H3 turbo LoRA by default, applied to the seam
  pass only. **Use LoRA in seam pass** turns it off; do that if the first pass
  already uses the same LoRA, and raise the steps.

The kept-side band replaces a strip of the original around your mask. With the
pass on, sending the result to the timeline grows its mask to keep that strip:
by the mask grow, one token for the edge snapping, and the kept band (48 px with
the default bands), with the usual feather beyond it.
