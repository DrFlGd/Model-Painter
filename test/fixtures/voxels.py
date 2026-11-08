# Reference values from scipy for the voxel tools, written as JSON for the TS test to compare.
import json, numpy as np
from scipy import ndimage
rng = np.random.default_rng(1)
g = rng.random((14, 11, 9)) > 0.8
out = {"shape": g.shape, "grid": g.astype(int).ravel().tolist()}
k = np.arange(-2, 3); x, y, z = np.meshgrid(k, k, k, indexing="ij"); ball = x*x + y*y + z*z <= 4 + 2
out["dil2"] = ndimage.binary_dilation(g, ball).astype(int).ravel().tolist()
out["close2"] = ndimage.binary_erosion(ndimage.binary_dilation(g, ball), ball).astype(int).ravel().tolist()
out["fill"] = ndimage.binary_fill_holes(ndimage.binary_dilation(g, ball)).astype(int).ravel().tolist()
out["cross3"] = ndimage.binary_dilation(g, iterations=3).astype(int).ravel().tolist()
out["ecross2"] = ndimage.binary_erosion(ndimage.binary_dilation(g, ball), iterations=2).astype(int).ravel().tolist()
lab, n = ndimage.label(g); out["blobs"] = int(n)
out["blur"] = ndimage.gaussian_filter(g.astype(np.float32), 0.7).ravel().round(5).tolist()
print(json.dumps(out))
