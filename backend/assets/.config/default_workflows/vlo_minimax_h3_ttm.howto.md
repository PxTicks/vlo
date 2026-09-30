## Dual-clock denoising

**This workflow brings a rough animation to life.** It blends a
coarsely animated moving object into a background image or video. Optional
start and end frames anchor the first and last frames of the result.

### Step by step

1. **Prepare your inputs.** For example:
   - Find an image containing the object you want to animate. This is your
     first frame.
   - Remove the object with **Qwen Image 2.1 Edit** to create an empty
     background, and place it on the timeline.
   - Place the original image on a track above it, masking out the background
     so only the object stays visible.

   > You can now move the object independently of the background.

2. **Animate the object.**
   - Click the object's clip on the timeline.
   - In **Adjust → Display**, choose **Add Path** — or press the yellow
     diamond to keyframe the animation instead.
   - Drag the object along the path you want it to follow.
   - Scrub the timeline to preview the motion.

3. **Select the whole area.** Click the main **load video** drop slot. The
   timeline selection view will ask which layer contains the moving object.

4. **Add keyframes (highly recommended).** Drop the original image into **Start frame** and/or
   **End frame** to pin it as the first or last frame of the result. You want a clean, coherent frame to serve as the start or end of the animation.

5. **Generate.**

### Choosing the start and end steps

The **Motion hold** slider in the **Time-to-Move** group sets two steps. The
defaults are a good starting point.

| Step | What it controls | Move it earlier | Move it later |
| --- | --- | --- | --- |
| **Lock-in step** (start) | How much noise the whole animation is seeded with — foreground *and* background | Both vary more over the animation | Both stick closer to your animation |
| **Release step** (end) | When the moving object stops being held to your animation — foreground *only* | The object is freed sooner and can vary more | The object follows your path more tightly |

> Holding things tightly has a cost: the model gets less room to clean up the
> seams of your cut-and-paste. If the object looks pasted on, try an earlier
> lock-in or release step.

::include{src="shared:minimax/prompting-base.md"}
