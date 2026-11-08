# Model Painter

Paint 3D models for multi-colour printing, from their textures or by hand,
into a painted 3MF that Bambu Studio, OrcaSlicer and PrusaSlicer read.

It brings together two things built for other projects: Dark STL's painting
of a model from its textures (each triangle split where the texture's colours
change across it, the way the slicers' own paint brushes split them, so the
model needs no extra triangles), and the hand-painting tools of Print Factory
and Gus Gus Goose (brush, fill, corners, text and picture stamps, with the
Prepare image dialog).

## Using it

1. **Model**: open a model, with its textures. Drop the model's whole folder
   on the window (or, in a browser, choose the model and its textures
   together) so the textures are found; the desktop app finds them beside the
   model by itself. Set the print height or width and turn it a quarter at a
   time; it always stands on the plate.
2. **Textures**: every material shows its texture (or why it was not found,
   with **Choose texture…**), and what it is painted from: its texture, its
   colour, the model's vertex colours, or nothing. **Prepare texture…** shows
   a texture beside what painting will make of it: the number of colours,
   merging similar ones, leaving out ones that cover little, a chip per colour
   with how much of the model it covers (click to drop it, or change it to
   the filament you have), smoothing, specks, exposure, contrast, saturation
   and the smallest feature kept. **Paint the model** paints every triangle.
3. **Paint**: up to 16 colours. Brush (only the side facing you, or both),
   fill up to creases, corners, text, picture stamps (any picture goes
   through **Prepare image**: background removal, colours, cleanup), and pick
   a colour from the model. Undo and redo with Ctrl+Z and Ctrl+Y.
4. **Save**: a painted 3MF (filament *n* is colour *n*; colour 1 is the
   object's own filament), a 3MF split into one solid part per colour (for a
   closed model), or an STL.

Models it reads: glTF and GLB, OBJ (with MTL), FBX, Collada (DAE), 3DS, PLY,
PSK and PSKX (UModel and FModel exports of Unreal games), STL and 3MF (a
painted 3MF from this app, Dark STL, Bambu Studio, OrcaSlicer or PrusaSlicer
comes back with its paint). Textures: DDS (BC1 to BC7 and plain), PNG, TGA,
JPEG, WebP, BMP and GIF.

## Desktop app

Windows releases carry an installer (`ModelPainter_<version>_x64-setup.exe`)
and a portable zip (`ModelPainter_<version>_x64-portable.zip`): unzip it
anywhere and run `Model Painter.exe`. Nothing else is needed.

## Building

```sh
npm install
npm run dev          # the page at http://localhost:5174
npm test             # the core: painting, textures, pictures, importers, 3MF
npm run typecheck
npm run smoke        # builds, then opens every kind of model in Chromium and paints it
npm run desktop      # the desktop app (needs Rust)
npx tauri build      # the Windows installer
```

The code: `src/core` is the app without a page (painting, texture painting,
picture readers, importers, 3MF and STL writing), tested under Node;
`src/web` is the page (the 3D view, the paint view, picking, the texture
worker, the dialogs); `src-tauri` is the desktop shell. Releases are made by
the workflow when a new version reaches `main` (see `docs/RELEASING.md`).
