# PREVIEW: smoother, evenly blended, more detailed beams. In: brand/preview/*-detail-{A,B}.png  Out: *-beams-{A,B}.png
import numpy as np; from PIL import Image, ImageFilter, ImageDraw
TINTS=[(0xd4,0xaf,0x37),(0xc4,0xcc,0xd8),(0x2a,0x55,0xe8),(0x7d,0xd3,0xfc),(0x86,0xef,0xac)]
def lum(c): return 0.2126*c[...,0]+0.7152*c[...,1]+0.0722*c[...,2]
def ss(a,b,x): t=np.clip((x-a)/(b-a),0,1); return t*t*(3-2*t)
def geom(name,guess,xmin):
    o=np.array(Image.open(f'brand/{name}-orig.png').convert('RGB')).astype(float)/255
    V=o.max(-1);S=(V-o.min(-1))/np.maximum(V,1e-6); m=(S>0.4)&(V>0.5); m[:,:xmin]=False
    ys,xs=np.where(m); best=None
    for dx in range(-40,41,4):
     for dy in range(-60,61,4):
      lx,ly=guess[0]+dx,guess[1]+dy; k=(ys<ly-30)&(np.hypot(xs-lx,ys-ly)>60)
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
    rays=sorted(rays,key=lambda r:-r[0]); assert len(rays)==5
    A=np.degrees(np.arctan2(ly-ys,xs-lx)); R=np.hypot(xs-lx,ys-ly)
    rmax=[np.percentile(R[(A>=a0)&(A<=a1)&(ys<ly)],97) for a0,a1 in rays]
    return lx,ly,rays,rmax,m
def run(name,v,guess,r0,xmin=0):
    P=dict(A=dict(k=0.55,stri=0.05,bloom=0.10,dust=60,overlap=0.06),B=dict(k=0.68,stri=0.09,bloom=0.16,dust=140,overlap=0.10))[v]
    rng=np.random.default_rng(11 if v=='A' else 12)
    lx,ly,rays,rmax,m=geom(name,guess,xmin)
    im=Image.open(f'brand/preview/{name}-detail-{v}.png'); alpha=np.array(im)[...,3] if im.mode=='RGBA' else None
    b=np.array(im.convert('RGB')).astype(np.float32)/255; H,W=b.shape[:2]
    Y,X=np.mgrid[0:H,0:W].astype(np.float32); A=np.degrees(np.arctan2(ly-Y,X-lx)); R=np.hypot(X-lx,Y-ly)
    above=ss(ly+r0*0.2,ly-r0*0.6,Y)          # only above the lamp
    shape=np.array(Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(12))).astype(np.float32)/255
    shape=np.maximum(shape,ss(r0*2.2,r0*0.8,R))*above
    L=lum(b); out=b.copy(); prof_all=np.zeros((H,W),np.float32); profs=[]
    # 1D angular noise for fine radial striations
    ang=np.linspace(0,180,1801); sn=rng.standard_normal(1801); sn=np.convolve(sn,np.ones(5)/5,'same'); sn/=sn.std()
    stri=np.interp(np.clip(A,0,180),ang,sn).astype(np.float32)
    for (a0,a1),t,rm in zip(rays,TINTS,rmax):
        c=(a0+a1)/2; hw=(a1-a0)/2+1.5; d=np.abs(A-c)
        prof=ss(hw*1.25,hw*0.25,d)*above                     # feathered, plateau in the middle
        rn=R/rm
        chroma=ss(r0*0.9/rm,0.30,rn)*(1-0.25*ss(0.8,1.15,rn))  # near-white core -> tint -> soft end
        cn=np.array(t,np.float32)/255; cn=cn/cn.max()
        gain=(0.92 if t==TINTS[2] else 1+0.5*(1/lum(cn)-1))
        tgt=np.clip(L[...,None]*cn*gain*0.98+0.02,0,1)
        w=(P['k']*prof*chroma*shape)[...,None]
        out=out*(1-w)+tgt*w
        profs.append(prof*shape); prof_all+=prof*shape
    beamL=L*prof_all.clip(0,1)
    # volumetric striations (multiplicative, follow the ray angle; fade near lamp)
    sf=(1+P['stri']*stri*ss(r0*1.2,r0*3,R))[...,None]
    bm=prof_all.clip(0,1)[...,None]
    out=out*(1-bm)+out*sf*bm
    # bloom where beams meet the lamp
    halo=np.exp(-((R-r0*1.0)/(r0*1.6))**2)*np.maximum(prof_all.clip(0,1),0.35)*above
    out+=P['bloom']*halo[...,None]*np.array([1,0.98,0.95],np.float32)
    # overlap glow between neighbouring beams (soft, additive)
    blur=lambda a,s: np.array(Image.fromarray((a*255).clip(0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(s))).astype(np.float32)/255
    sg=max(4,r0*0.35)
    for i in range(4):
        ov=blur(profs[i],sg)*blur(profs[i+1],sg)
        tint=(np.array(TINTS[i])+np.array(TINTS[i+1]))/510
        out+=P['overlap']*4*ov[...,None]*(0.6+0.4*tint)*np.exp(-R/(r0*6))[...,None]
    # light dust particles inside beams
    S=4; dl=Image.new('L',(W*S,H*S),0); dd=ImageDraw.Draw(dl)
    n=int(P['dust']*(W*H)/(1024*1024)) if name=='logo' else int(P['dust']*0.6)
    cnt=0
    while cnt<n:
        x,y=rng.uniform(0,W),rng.uniform(0,H)
        if prof_all[int(y),int(x)]>0.5 and R[int(y),int(x)]>r0*1.6:
            rr=rng.uniform(0.4,1.2)*(1.4 if name=='logo' else 0.9); a=int(rng.uniform(70,200))
            dd.ellipse([(x-rr)*S,(y-rr)*S,(x+rr)*S,(y+rr)*S],fill=a); cnt+=1
    dust=np.array(dl.resize((W,H),Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.4))).astype(np.float32)/255
    out+=0.55*dust[...,None]*(1-L[...,None]*0.5)
    # dither to prevent banding
    out+=(rng.random((H,W,1)).astype(np.float32)-0.5)/255*1.2*bm
    res=(out.clip(0,1)*255+0.5).astype(np.uint8)
    if alpha is not None: res=np.dstack([res,alpha])
    img=Image.fromarray(res); img.save(f'brand/preview/{name}-beams-{v}.png'); return img
outs={}
for v in 'AB':
    outs[('logo',v)]=run('logo',v,(502,420),90)
    outs[('banner',v)]=run('banner',v,(1220,190),40,950)
# comparison: rows logo A, logo B, banner A, banner B; columns current vs new
cells=[]
for name in ['logo','banner']:
    for v in 'AB':
        cur=Image.open(f'brand/preview/{name}-detail-{v}.png').convert('RGB'); new=outs[(name,v)].convert('RGB')
        if name=='logo': box=(0,0,1024,620); sz=(700,424)
        else: box=(960,0,1500,420); sz=(540,420)
        cells.append((f'{name} {v}',cur.crop(box).resize(sz,Image.LANCZOS),new.crop(box).resize(sz,Image.LANCZOS)))
Wd=10+max(c[1].width for c in cells)*2+30; Hh=sum(c[1].height+34 for c in cells)+10
cv=Image.new('RGB',(Wd,Hh),'#222'); dr=ImageDraw.Draw(cv); y=10
for lab,a,bb in cells:
    dr.text((10,y),f'{lab}: current',fill='#fff'); dr.text((a.width+30,y),f'{lab}: new beams',fill='#fff'); y+=20
    cv.paste(a,(10,y)); cv.paste(bb,(a.width+30,y)); y+=a.height+14
cv.save('screens/beams-compare.png'); print(cv.size)
