# Robot Host Character Pack

19 background-free animated clips of a floating robot presenter, split by action so an editor
(or an AI agent) can cut them against a voiceover.

Original artwork, built as a parametric SVG rig in the soft-gradient style of your reference —
rounder helmet, bigger head-to-body ratio, and a chunkier body than the original, per your note
about cuter proportions.

**This pack uses the exact same 19 action IDs as the human host pack**, so the two are drop-in
interchangeable. An agent written against one manifest will drive the other without changes, and
you can swap presenters across a series by pointing at a different folder.

```
robot_character_pack/
├── manifest.json          ← machine-readable index (start here for agents)
├── preview.html           ← self-contained; open in any browser to see all 19 clips
├── character_still.png    ← neutral pose, transparent PNG
├── gifs/                  ← 19 transparent GIFs
└── mov/                   ← 19 QuickTime MOVs with a real alpha channel
```

## Formats

| Format | Alpha | Size | Use for |
|---|---|---|---|
| `gifs/` | 1-bit (hard edge) | ~750–1170 KB each | Previews, slides, chat, web embeds |
| `mov/` | Full 8-bit alpha | ~2 MB each | **Preferred for actual video.** Soft edges, lossless |

The MOVs use the PNG codec rather than QuickTime Animation. That's a deliberate change from the
human pack: Animation is run-length encoded, which collapses on smooth gradients — the same clip
came out at 6.6 MB as Animation versus 1.8 MB as PNG, for identical quality. Every major NLE reads
both.

Need numbered frames instead?

```bash
ffmpeg -i mov/talk_neutral_loop.mov frames/%04d.png
```

## Canvas

640 × 680, transparent, robot centred. Unlike the human host — whose torso is cropped by the
bottom edge — the robot floats clear of all four edges, so the full body is visible and you can
place it anywhere in frame rather than anchoring it to the bottom.

There is **no ground shadow**. A soft drop shadow can't survive GIF's on/off transparency (it would
threshold into a hard grey oval), and a contact shadow on a transparent background is wrong
anyway once the clip sits over your own footage. The float is carried by the hover motion instead.
If you want a shadow, add an ellipse with a blur in your editor underneath the clip.

Every clip is a **seamless loop** — first and last frames match — so hold any clip for as long as
the scene needs by repeating it. All 19 share identical framing, so you can hard-cut between any
two without the robot jumping.

## The clips

### Speaking (mouth moving)
`talk_neutral_loop` · `talk_emphatic_loop` · `talk_hand_raised_loop` ·
`talk_both_hands_explain_loop` · `talk_point_right_loop` · `talk_point_left_loop` ·
`present_open_palm_right_loop` · `point_up_key_point`

### Silent / idle
`idle_neutral_loop` · `listening_attentive_loop`

### Reactions (one beat each)
`thinking_hand_on_chin_loop` · `nod_yes_agree` · `shake_head_no_disagree` ·
`thumbs_up_approve` · `shrug_uncertain` · `surprised_reaction` · `laugh_happy_loop`

### Transitions
`wave_hello_intro` · `wave_goodbye_outro`

Note that `talk_point_right_loop` / `talk_point_left_loop` are named from the **viewer's**
perspective — `right` means the graphic sits on the right of your frame.

## What the screen face buys you

Because the face is a display rather than anatomy, expression is a swap rather than a deformation.
The rig drives eye shape (normal, blink, happy arcs, wide, squint), independent eye direction, nine
mouth shapes including a phoneme set for lip-sync, and antenna brightness.

The antenna does real work as a status light: it pulses like a loading indicator through
`thinking_hand_on_chin_loop`, flares on `surprised_reaction` and `point_up_key_point`, and dims on
`shake_head_no_disagree` and `shrug_uncertain`. It reads clearly even at a small size, which makes
it the most legible signal in the pack when the robot is composited small in a corner.

## For an AI agent

`manifest.json` carries `use_when` in plain language plus `category`, `tags`, `mouth_moving`,
`gesture` and `duration_ms`, and an `agent_selection_rules` array. Short version:

1. Dialogue in the scene → `mouth_moving: true`. Silent → `mouth_moving: false`.
2. Match the layout: graphic on the right → `talk_point_right_loop`; on the left → `talk_point_left_loop`.
3. Reactions are a single beat. Play one, then return to a talking or idle clip. Never chain two.
4. `wave_hello_intro` first appearance only; `wave_goodbye_outro` last only.
5. No rule fits → `talk_neutral_loop` if speaking, `idle_neutral_loop` if not.

## Extending

The rig is parametric, so new actions are additions to the same rig rather than new artwork:
head rotation, hover, eye shape and direction, mouth phoneme, antenna glow, and both arms
(shoulder / elbow / wrist / hand shape) are independent parameters. Screen-face states are
especially cheap — loading spinner, error X, heart eyes, a percentage readout, or a colour change
from cyan to amber or red for warning states.
