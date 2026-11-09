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

## 0.3 (built)

- Cut tab, ported from Dark STL's cut.py (core/cut.ts): planes split the solid
  one after another (manifold-3d `splitByPlane`); each cut's joint is flat,
  pegs, dowels, magnets or a key, with its own clearance. The cut face is
  sliced (`CrossSection`) and features placed per island on a grid of
  candidates inset by radius + wall, at the deepest spot or spread apart;
  each is probed against the far side of both pieces and shortened, centred
  alone or left out (the tab counts the places left flat). A plane lying on a
  face of the model is nudged 1.3 µm so it doesn't leave a sheet.
- The original is made solid with finish.ts (as Dark STL's `make_solid`);
  the watertight model is cut as it is. The solid is kept in the worker
  under the model's id and version, so moving a cut only cuts again.
- Provenance: every piece triangle knows the model triangle it is a piece of,
  or BASE for the cut faces, pegs and holes, so finish-map.ts carries paint,
  UVs and materials onto the pieces and the cut faces take colour 1.
- In the view: a translucent square per cut through the model's middle,
  dragged along its normal, tilted by its round handle, or moved through a
  picked point; the pieces in colours or their paint, spread apart.
- Save › Each piece: every piece in its own painted 3MF, split 3MF or STL in
  a new `<name>_pieces` folder (desktop commands pick_folder, make_folder,
  write_file; a zip in a browser), laid flat on its biggest cut face without
  pegs or tongue (printPose), dowels on end, or where it is in the model.
- Checked against Dark STL: its test figure cut with pegs, dowels and a key
  gives the same pieces and volumes (to 0.1 mm³); a Bloodborne model of 30
  parts cut across Z with pegs gives the same piece count, joints placed and
  places left flat, volumes within 0.6 %, except a piece holding a part
  rebuilt from voxels, where Dark STL itself gives that part 941 or 1035 mm³
  depending on its random seed (here 1035).

## Next

- Dark STL retires its Finish, Cut and Paint tabs now that Model Painter has
  them (Jerred, 2026-11-09).

- Smooth (non-faceted) shading in the paint view for organic models.
- Show the reduced textures on the model inside Prepare texture.
- Save and reopen a painting session (paint, palette, size) without a 3MF.
- Skeletal poses for game models (Dark STL has them).
