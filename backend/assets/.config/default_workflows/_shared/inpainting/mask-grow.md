### Mask edges

The model always regenerates every block your mask touches, so nothing under
the mask is kept, however the mask lines up with those blocks.

**Mask grow** (in **Advanced Settings**, 0 px by default) widens the mask before
generating. Use it when the mask is tight, like one from automatic
segmentation: it leaves the object's edges, motion blur and shadow just outside
the mask, and the model can rebuild the object from those traces. A margin of
about 16 px covers them.

**Fill masked area before encoding** (in **Advanced Settings**, on by default)
replaces what is under the mask with a smooth continuation of
the colours around it before the video is encoded. The model never uses that
content at full denoise, but a hard edge there, like the black around a
shrunken clip you are outpainting, can otherwise show as a dark outline. It
does nothing below full denoise, where the content under the mask is the
starting point.
