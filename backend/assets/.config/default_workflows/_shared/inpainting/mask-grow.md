### Grow mask

**Grow mask** (in **Advanced Settings**, on by default) widens the mask by a
small margin before generating. A tight mask, like one from automatic
segmentation, leaves the object's edges, motion blur and shadow just outside
it, and the model can rebuild the object from those traces. The margin covers
them, and also lines the mask up with the blocks the model actually generates
in, so nothing under the mask is kept.

Turn it off only when you have already grown or feathered the mask yourself and
need the edit to stay exactly inside it.
