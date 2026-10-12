import numpy as np
from PIL import Image
def rec(src,dst):
    im=Image.open(src); a=None
    if im.mode=='RGBA': a=np.array(im)[...,3]
    x=np.array(im.convert('RGB')).astype(float)/255
    L=0.2126*x[...,0]+0.7152*x[...,1]+0.0722*x[...,2]
    V=x.max(-1)
    w=np.clip((V-0.30)/0.35,0,1)          # bright -> silver, dark -> black
    S=(V-x.min(-1))/np.maximum(V,1e-6)
    bright=np.clip(L*1.12+0.05+0.3*S*w,0,1)
    dark=L**2.2*0.6                        # navy ~0.1 -> ~0.004; edge highlights stay dark grey
    o=w*bright+(1-w)*dark
    o=np.clip(o,0.012,1)  # floor ~#030303
    out=np.repeat((o*255).round().astype(np.uint8)[...,None],3,-1)
    if a is not None: out=np.dstack([out,a])
    Image.fromarray(out).save(dst)
rec('brand/logo-orig.png','brand/logo-black.png'); rec('brand/banner-orig.png','brand/banner-black.png')
for o,n,p in [('brand/logo-orig.png','brand/logo-black.png',None),('brand/banner-orig.png','brand/banner-black.png',None)]:pass
lo=[Image.open(f).convert('RGB').resize((500,500)) for f in ['brand/logo-orig.png','brand/logo-black.png']]
ba=[Image.open(f).convert('RGB').resize((1000,333)) for f in ['brand/banner-orig.png','brand/banner-black.png']]
c=Image.new('RGB',(2020,1210),'#333')
c.paste(lo[0],(10,10));c.paste(lo[1],(520,10));c.paste(ba[0],(10,530));c.paste(ba[1],(1020,530))
c.paste(ba[0].resize((500,167)),(1030,10));c.paste(ba[1].resize((500,167)),(1030,190))
c.save('screens/brand-black-preview.png')
