# Model Painter plan

## 0.1 (built)

- Core: compact paint (slicer codes per split triangle), brush, stamp, fill,
  undo; texture painting ported from Dark STL (palette by k-means in Oklab
  over the surface, reduce, clean, per-piece sampling); DDS/PNG/TGA readers;
  importers for glTF, OBJ, PSK, STL and 3MF, and FBX, Collada, 3DS and PLY
  through three.js; painted 3MF, split-by-colour 3MF and STL writers.
- Page: Model (open, size, turn), Textures (materials, Prepare texture,
  paint), Paint (palette, brush, fill, corners, text, picture stamps with
  Prepare image, pick), Save; the texture work in a worker.
- Desktop: Tauri shell (open and save dialogs, textures found beside the
  model, drag and drop, the file it was opened with); Windows installer and
  portable zip from the workflow.

## 0.1.1 (built)

- Move round the model (middle drag, Shift + right drag, Space + drag, the
  Move button); click a colour to use it, the arrow beside it to edit it;
  four fill modes (up to creases, same colour, flat area, whole part).

## 0.2 (built)

- Finish tab, ported from Dark STL's finishing: each part made solid (closed,
  openings closed flat, sheets thickened, broken parts rebuilt from voxels),
  joined into one solid with manifold-3d; hollows filled, narrow gaps
  bridged, loose bits removed; bottom cut flat; round or square base.
- Provenance through manifold-3d (faceID per model triangle) carries paint,
  UVs and materials onto the watertight model (finish-map.ts); new surfaces
  take them from the nearest of the model facing their way.
- Original and watertight models both kept, each with its own paint and
  palette.

## Next

- Decide with Jerred whether finishing and painting leave Dark STL for good
  now that Model Painter has them.

- Smooth (non-faceted) shading in the paint view for organic models.
- Show the reduced textures on the model inside Prepare texture.
- Save and reopen a painting session (paint, palette, size) without a 3MF.
- Skeletal poses for game models (Dark STL has them).
