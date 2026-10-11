<!-- Technical manual for the tools; inserted into the system prompt as {{STUDIO_MANUAL}}. -->

The studio works like a layered digital painting/design application.

## Canvas & coordinates
- Coordinates are canvas pixels; (0, 0) is the top-left corner, x grows right, y grows down.
- Call `set_canvas` first if you want a size, proportion or paper color other than the default 1200×1200 white. You cannot change it after making marks.
- The canvas view you receive after each turn may be scaled down; always work in canvas pixel coordinates. Use `look` with `grid: true` when you need to place things precisely, or with a region to inspect detail.

## Layers
- The document is a stack of layers, bottom to top. There is a "Background" layer (id `bg`) filled with the paper color unless you chose a transparent background.
- Pixel layers hold paint. Every drawing tool needs a target layer — create layers with `new_layer` and refer to them by id (e.g. `L3`) or name.
- Each layer has opacity and a blend mode: normal, multiply (darkens, like glazing), screen (lightens, like light), overlay / soft-light / hard-light (contrast), darken, lighten, color-dodge, color-burn, difference, exclusion, hue, saturation, color, luminosity, add (light adds up).
- `alpha_lock` on a layer: paint only lands where the layer already has pixels — shade or texture inside a shape without spilling.
- `clip_to_below`: a layer is only visible where the layer directly beneath it has pixels (clipping mask). Several consecutive clipped layers all clip to the same base.
- Adjustment layers (`new_adjustment_layer`) non-destructively change the look of everything below: curves, levels, hue_saturation, color_balance, brightness_contrast, gradient_map, posterize, threshold, invert, black_white, photo_filter, vibrance. Edit them later with `set_layer`.
- Working on separate layers lets you revise: hide, reorder, re-blend, transform, clear or delete them later. There is no undo — layers are how you keep options open.

## Brushes (`brush_stroke`)
Strokes are drawn by stamping the brush tip along a smooth curve through your points. Watchers see each stroke drawn in real time, in the order you make them.
- Points: `[[x, y], ...]` or with pressure `[[x, y, pressure], ...]` (0–1). Pressure changes width and/or density depending on the brush. A curve is drawn smoothly through the points, so 4–20 well-chosen points usually suffice for a gesture; use more for intricate lines.
- Or give SVG path data in `path` (with an optional `pressure` profile) for precise curves.
- `strokes`: many strokes with the same brush in one call — hatching, grass, hair, rain, texture, scribbles.
- Brush presets (each has sensible default size/flow/hardness you can override):
  - `round` — general-purpose round brush, pressure affects width.
  - `airbrush` — very soft, low flow; build up glows, shading and atmosphere with repeated passes.
  - `pencil` — thin, grainy graphite-like line that catches the paper texture.
  - `ink` — crisp, highly pressure-sensitive line with tapered ends; drawing, calligraphy, line art.
  - `charcoal` — broad, rough, grainy; expressive tone and gesture.
  - `chalk` — dry, broken, very textured.
  - `bristle` — oil/acrylic brush with individual hairs that streak and run dry along the stroke.
  - `flat` — flat calligraphic tip (set `angle`, `roundness`); thick-thin strokes.
  - `watercolor` — translucent wet wash with pooled edges; layer washes to deepen.
  - `marker` — even, semi-transparent felt-tip; overlapping strokes darken.
  - `spray` — sprayed speckle.
  - `stipple` — scattered dots (dotwork).
- Useful settings: `size`, `opacity` (whole stroke), `flow` (per-dab buildup), `hardness`, `spacing`, `jitter`, `taper_start`/`taper_end` (px), `blend_mode`, `erase: true` (erase with that brush), `selection` (SVG path: paint only inside it).
- `smudge` drags existing pixels along a path like a finger in wet paint.

## Vector shapes, fills, type
- `draw_path`: any shape from SVG path data, with `fill` / `fill_gradient` and/or `stroke` outline (width, caps, joins, dash). `draw_shape` does rect, ellipse, polygon, star and line without writing path data.
- `fill`: fill a whole layer or an SVG region with a color or gradient (linear, radial, conic).
- `bucket_fill`: flood-fill an enclosed area (e.g. inside line work) by color similarity.
- `draw_text`: set type in any of the studio's typefaces, with size, weight, italic, tracking, line height, wrapping, rotation, outline and gradient fill.
- Gradients: `{ "type": "linear", "x0", "y0", "x1", "y1", "stops": [{ "offset": 0, "color": "#..." }, ...] }`; radial uses `cx, cy, r`; conic uses `cx, cy, angle`.

## Filters (`apply_filter`) — destructive, on one layer
gaussian_blur · motion_blur · add_noise · unsharp_mask · pixelate · ripple · twirl · turbulence (organic warping) · glow · halftone · clouds (fractal noise between two colors; replaces the layer) · emboss · find_edges. Most accept a `selection`.

## Transform
`transform_layer` moves, rotates, scales or flips a layer's pixels.

## Seeing
- After every turn you see the whole composite canvas.
- `look`: zoom into a region, overlay a coordinate grid, or view one layer in isolation.
- `sample_color`: eyedropper.

## Other
- `chance`: genuine random numbers, if you want chance in your process.
- `sketchbook`: private notes that persist through the session.
- `finish`: declare the work complete, with a title and a statement.

Errors come back as tool results; read them and adjust.
