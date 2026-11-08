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

## Next

- Smooth (non-faceted) shading in the paint view for organic models.
- Show the reduced textures on the model inside Prepare texture.
- Save and reopen a painting session (paint, palette, size) without a 3MF.
- Skeletal poses for game models (Dark STL has them).
