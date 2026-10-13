# Build transparent circular logos from brand/logo-src.png: full (with MULTISEA text) and icon-only (M ribbon in ring).
import numpy as np; from PIL import Image, ImageDraw, ImageFilter
src=Image.open('brand/logo-src.png').convert('RGB'); W,H=src.size
cx,cy,R=625,617,626
def circ(img):
    S=4; m=Image.new('L',(W*S,H*S),0); ImageDraw.Draw(m).ellipse([(cx-R)*S,(cy-R)*S,(cx+R)*S,(cy+R)*S],fill=255)
    m=m.resize((W,H),Image.LANCZOS); out=img.convert('RGBA'); out.putalpha(m)
    s=min(cx,cy,W-cx,H-cy,R); return out.crop((cx-R,cy-R,cx+R,cy+R)).resize((1024,1024),Image.LANCZOS)
circ(src).save('brand/logo-full-1024.png')
a=np.array(src).astype(np.float32)
# erase the MULTISEA text (on black) with a feathered mask, then move the M down to the ring's center
tm=Image.new('L',(W,H),0); ImageDraw.Draw(tm).rectangle([150,770,1100,885],fill=255); tm=np.array(tm.filter(ImageFilter.GaussianBlur(6)))/255.
bg=np.zeros_like(a); a=a*(1-tm[...,None])+bg*tm[...,None]
y0,y1,x0,x1=300,762,118,1132; dy=58
blk=a[y0:y1,x0:x1].copy()
lum=blk.mean(-1); al=np.clip((lum-18)/50,0,1)
al=np.array(Image.fromarray((al*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32)/255
fe=Image.new('L',(x1-x0,y1-y0),0); ImageDraw.Draw(fe).rectangle([6,6,x1-x0-7,y1-y0-7],fill=255); al*=np.array(fe.filter(ImageFilter.GaussianBlur(3)))/255.
a[y0:y1,x0:x1]*=(1-al[...,None])
r=a[y0+dy:y1+dy,x0:x1]; a[y0+dy:y1+dy,x0:x1]=r*(1-al[...,None])+blk*al[...,None]
Yy,Xx=np.mgrid[0:H,0:W]; rr=np.hypot(Xx-cx,Yy-cy)/R; L2=a.mean(-1)
k=np.clip((L2-14)/22,0,1); inner=np.clip((0.86-rr)/0.06,0,1)
a*= (1-inner*(1-k)*0.92)[...,None]
circ(Image.fromarray(a.clip(0,255).astype(np.uint8))).save('brand/logo-icon-1024.png')
