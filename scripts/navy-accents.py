import numpy as np
from PIL import Image
o=np.array(Image.open('brand/banner-orig.png').convert('RGB')).astype(float)
b=np.array(Image.open('brand/banner-black.png').convert('RGB')).astype(float)
H,W=b.shape[:2]; NAVY=np.array([0x1e,0x40,0xaf],float)
# 1) .io mask from original blue pixels (antialiased via blueness), left text area only
blu=np.clip((o[...,2]-o[...,0]-40)/150,0,1)*np.clip((o[...,2]-120)/80,0,1); m=np.zeros((H,W)); m[140:330,660:900]=blu[140:330,660:900]
b=b*(1-m[...,None])+NAVY*m[...,None]
# 2) water: below wave line per column
white=(b.min(-1)>200)
wb=np.full(W,np.nan)
for x in range(W):
    ys=np.where(white[400:,x])[0]
    if len(ys): wb[x]=400+ys.max()
xs=np.arange(W); ok=~np.isnan(wb); wb=np.interp(xs,xs[ok],wb[ok])
Y=np.arange(H)[:,None]; d=Y-wb[None,:]
g=np.where(d>1, np.clip(1-(d-1)/(H-wb[None,:]),0,1)**1.6, 0)*0.75
lum=b.mean(-1)/255; g=g*(1-np.clip(lum*3,0,1))   # don't tint white/bright details
b=b*(1-g[...,None])+NAVY*g[...,None]
Image.fromarray(b.clip(0,255).astype(np.uint8)).save('brand/banner-black.png')
