# Tint the centers of the 5 lighthouse rays (pixel-level). Run after recolor.py (+ navy-accents.py for banner).
import numpy as np; from PIL import Image
TINTS=[(0xd4,0xaf,0x37),(0xc8,0xd0,0xdc),(0x5b,0x7f,0xe6),(0x7d,0xd3,0xfc),(0x86,0xef,0xac)]  # left -> right
def lum(c): return 0.2126*c[...,0]+0.7152*c[...,1]+0.0722*c[...,2]
def run(name,dst,lamp_guess,r0,xmin=0):
    o=np.array(Image.open(f'brand/{name}-orig.png').convert('RGB')).astype(float)/255
    im=Image.open(dst); alpha=np.array(im)[...,3] if im.mode=='RGBA' else None
    b=np.array(im.convert('RGB')).astype(float)/255
    V=o.max(-1);S=(V-o.min(-1))/np.maximum(V,1e-6); m=(S>0.4)&(V>0.5); m[:,:xmin]=False
    ys,xs=np.where(m); cx,cy=lamp_guess; best=None
    for dx in range(-40,41,4):
     for dy in range(-60,61,4):
      lx,ly=cx+dx,cy+dy; k=(ys<ly-30)&(np.hypot(xs-lx,ys-ly)>60)
      h=np.histogram(np.degrees(np.arctan2(ly-ys[k],xs[k]-lx)),bins=180,range=(0,180))[0]+1e-9
      p=h/h.sum(); e=-(p*np.log(p)).sum()
      if best is None or e<best[0]: best=(e,lx,ly,h)
    _,lx,ly,h=best; on=h>h.max()*0.15; rays=[]; i=0
    while i<180:
        if on[i]:
            j=i
            while j<180 and on[j]: j+=1
            if j-i>=4: rays.append((i,j))
            i=j
        else: i+=1
    assert len(rays)==5, rays
    rays=sorted(rays,key=lambda r:-r[0])  # left (large angle) -> right
    H,W=b.shape[:2]; Y,X=np.mgrid[0:H,0:W]; A=np.degrees(np.arctan2(ly-Y,X-lx)); R=np.hypot(X-lx,Y-ly)
    radial=np.clip((R-r0)/r0,0,1)*(Y<ly)
    L=lum(b)
    from PIL import ImageFilter
    rm=np.array(Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(8))).astype(float)/255
    radial=radial*rm
    for (a0,a1),t in zip(rays,TINTS):
        c=(a0+a1)/2; hw=(a1-a0)/2; t=np.array(t,float)/255
        w=np.clip(1-np.abs(A-c)/hw,0,1)**1.2*0.5*radial
        tgt=np.clip(L[...,None]*0.92+(t-lum(t))[None,None,:]*1.8,0,1)
        b=b*(1-w[...,None])+tgt*w[...,None]
    out=(b*255).round().clip(0,255).astype(np.uint8)
    if alpha is not None: out=np.dstack([out,alpha])
    Image.fromarray(out).save(dst); print(name,'lamp',lx,ly,'rays',rays)
run('logo','brand/logo-black.png',(502,420),90)
run('banner','brand/banner-black.png',(1220,190),40,950)
