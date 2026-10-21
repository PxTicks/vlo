### Temporal feather

When the mask starts or stops partway through the video, the generated footage
can cut in and out abruptly. The temporal feather softens those cuts: the frames
just before and after each masked stretch are partly regenerated, a little less
with each step away from the mask, so the model eases into and out of the new
content. It is off by default.

In **Advanced Settings ▸ Temporal feather**:

- **Feather mask in time** turns it on. Toggle it with the same seed to compare.
- **Lead ramp** and **Tail ramp** set how far the feather reaches before and
  after the mask, in latent frames (about 4 video frames each). Both are 2 by
  default; 0 leaves that side hard.
- **Feather curve** sets the shape of the ramp. Cosine and smoothstep ease in
  at both ends; linear and exponential leave a visible kink where the ramp meets
  the mask.

The ramp frames lie outside your mask, so the feather changes footage there
too, if only slightly. It has no effect on a mask that covers the whole video.
