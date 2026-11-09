# Model Painter

Paint 3D models for multi-colour printing, from their textures or by hand,
into a painted 3MF that Bambu Studio, OrcaSlicer and PrusaSlicer read.

It brings together things built for other projects: Dark STL's painting of a
model from its textures (each triangle split where the texture's colours
change across it, the way the slicers' own paint brushes split them, so the
model needs no extra triangles), its finishing (making a game model one
watertight solid) and its cutting (into pieces with pegs, dowels, magnets or
a key), and the hand-painting tools of Print Factory and Gus Gus Goose
(brush, fill, corners, text and picture stamps, with the Prepare image
dialog).

## Using it

1. **Model**: open a model, with its textures. Drop the model's whole folder
   on the window (or, in a browser, choose the model and its textures
   together) so the textures are found; the desktop app finds them beside the
   model by itself. Set the print height or width and turn it a quarter at a
   time; it always stands on the plate.
2. **Finish** (optional): make it watertight for printing, as Dark STL's
   Finish tab does. Game models are parts pushed into each other and open
   sheets; each part is made solid (closed as it is, small openings closed
   flat, open sheets such as capes thickened, broken parts rebuilt from
   voxels) and they are joined into one solid with only the outside left.
   Hollows sealed inside it are filled; narrow gaps (a sleeve round an arm)
   can be bridged under the surface, and loose bits removed. The bottom can
   be cut flat and a round or square base added under the feet. The paint,
   UVs and materials come along: what is still the model's surface keeps
   them exactly, and what finishing made takes them from the nearest surface
   facing the same way. The original and the watertight model are both kept,
   each with its own paint; the one shown is the one painted and saved.
3. **Cut** (optional): cut the model shown into pieces that fit your printer,
   as Dark STL's Cut tab does. Add a cut **across X, Y or Z** or **facing
   me**; each is a see-through square in the view: drag it to slide it, drag
   its round handle to tilt it, or **Pick a point** on the model for it to go
   through (the tab has the position, tilt and turn too). Each cut has its
   own joint and clearance: **flat** (to glue), **pegs** (holes wider by the
   clearance), **dowels** (holes both sides, the dowels as pieces too or not,
   for pins or filament), **magnets** (pockets both sides) or a **key** (a
   tongue in the shape of the cut face into a groove). Pegs, dowels and
   magnets go on each separate area of the cut face as far from its edge as
   they can, keeping the **wall around joints** (1.6 mm); one that would
   break through the far side of a piece is made shorter or left out, and the
   tab says where. The original is made solid first (as Make watertight does);
   the watertight model is cut as it is. The pieces show in colours or in
   their paint, spread apart by a slider, with their size, triangles and
   volume; they keep the model's paint, UVs and materials, the cut faces and
   joints colour 1. Moving a cut only cuts again: the solid is kept.
4. **Textures**: every material shows its texture (or why it was not found,
   with **Choose texture…**), and what it is painted from: its texture, its
   colour, the model's vertex colours, or nothing. **Prepare texture…** shows
   a texture beside what painting will make of it: the number of colours,
   merging similar ones, leaving out ones that cover little, a chip per colour
   with how much of the model it covers (click to drop it, or change it to
   the filament you have), smoothing, specks, exposure, contrast, saturation
   and the smallest feature kept. **Paint the model** paints every triangle.
5. **Paint**: up to 16 colours (click one to paint with it, its arrow to
   change it). Brush (only the side facing you, or both); fill over the same
   colour (to repaint one painted area), up to creases, over a flat area, or
   a whole part; corners, text, picture stamps (any picture goes through
   **Prepare image**: background removal, colours, cleanup), and pick a
   colour from the model. Undo and redo with Ctrl+Z and Ctrl+Y.
6. **Save**: a painted 3MF (filament *n* is colour *n*; colour 1 is the
   object's own filament), a 3MF split into one solid part per colour (for a
   closed model, such as the watertight one), or an STL. **Each piece** saves
   every piece of the cut model to its own file in a new folder
   `<name>_pieces` (a zip of it in a browser), laid flat on its biggest cut
   face without pegs or a tongue on it and centred, dowels on end; or where
   each is in the model.

Moving round the model: the right button turns it while painting (the left
elsewhere), the middle button, Shift with the turning button, Space with the
left button, or the Move button (H) slides it, and the wheel zooms towards the
mouse.

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
npm test             # the core: painting, textures, finishing, pictures, importers, 3MF
npm run typecheck
npm run smoke        # builds, then opens every kind of model in Chromium and paints it
npm run desktop      # the desktop app (needs Rust)
npx tauri build      # the Windows installer
```

The code: `src/core` is the app without a page (painting, texture painting,
finishing, picture readers, importers, 3MF and STL writing), tested under
Node; `src/web` is the page (the 3D view, the paint view, picking, the
worker for textures and finishing, the dialogs); `src-tauri` is the desktop shell. Releases are made by
the workflow when a new version reaches `main` (see `docs/RELEASING.md`).
