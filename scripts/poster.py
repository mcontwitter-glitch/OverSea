# Build brand/poster-real.png: real multisea.io screenshots in the device screens + real supported chains row.
import cv2, numpy as np; from PIL import Image, ImageDraw, ImageFont, ImageFilter
K=2
P=Image.open('brand/poster-src.jpg').convert('RGB'); P=P.resize((P.width*K,P.height*K),Image.LANCZOS)
img=np.array(P).astype(np.float32)
def warp(shot,quad,radius=0,glare=0.10):
    s=np.array(Image.open(shot).convert('RGB')).astype(np.float32); h,w=s.shape[:2]
    q=np.float32(quad)*K
    M=cv2.getPerspectiveTransform(np.float32([[0,0],[w,0],[w,h],[0,h]]),q)
    H,W=img.shape[:2]
    out=cv2.warpPerspective(s,M,(W,H),flags=cv2.INTER_AREA if w>W/4 else cv2.INTER_CUBIC)
    m=np.zeros((h*2,w*2),np.uint8)  # rounded mask drawn in source space at 2x
    pm=Image.new('L',(w*2,h*2),0); ImageDraw.Draw(pm).rounded_rectangle([0,0,w*2-1,h*2-1],radius=int(radius*2*w/ (np.linalg.norm(q[1]-q[0])/1)),fill=255) if radius else ImageDraw.Draw(pm).rectangle([0,0,w*2,h*2],fill=255)
    pm=np.array(pm.resize((w,h),Image.LANCZOS)).astype(np.float32)/255
    mk=cv2.warpPerspective(pm,M,(W,H),flags=cv2.INTER_LINEAR)
    # glare: diagonal soft highlight in source space
    yy,xx=np.mgrid[0:h,0:w].astype(np.float32); g=np.clip(1-np.abs((xx/w+yy/h*0.6)-0.55)/0.25,0,1)**2*glare
    gl=cv2.warpPerspective(g,M,(W,H))
    out=out*0.96+255*gl[...,None]
    return out,mk
global_img=img
lap,ml=warp('/tmp/pst/desk.png',[(121,876),(723,880),(727,1289),(117,1291)],0,0.07)
img=img*(1-ml[...,None])+lap*ml[...,None]
ph,mp=warp('/tmp/pst/mob.png',[(751,927),(953,933),(941,1316),(738,1311)],22,0.12)
img=img*(1-mp[...,None])+ph*mp[...,None]
# chains row: cover old badges with a band interpolated from rows above/below
y0,y1=1388*K,1498*K; x0,x1=40*K,990*K
top=cv2.GaussianBlur(img[y0-12:y0-2],(0,0),6).mean(0); bot=cv2.GaussianBlur(img[y1+2:y1+12],(0,0),6).mean(0)
t=np.linspace(0,1,y1-y0)[:,None,None]; band=top[None]*(1-t)+bot[None]*t
fx=np.ones(img.shape[1],np.float32); ramp=40*K; fx[:x0]=0; fx[x1:]=0
fx[x0:x0+ramp]=np.linspace(0,1,ramp); fx[x1-ramp:x1]=np.linspace(1,0,ramp)
band+=np.random.default_rng(1).normal(0,1.2,band.shape)
fy=np.ones(y1-y0,np.float32); fy[:10]=np.linspace(0,1,10); fy[-10:]=np.linspace(1,0,10)
f=(fy[:,None]*fx[None,:])[...,None]
img[y0:y1]=img[y0:y1]*(1-f)+band*f
base=Image.fromarray(img.clip(0,255).astype(np.uint8)).convert('RGBA')
S=2; L=Image.new('RGBA',(base.width*S,base.height*S),(0,0,0,0)); d=ImageDraw.Draw(L)
glow=Image.new('RGBA',L.size,(0,0,0,0)); dg=ImageDraw.Draw(glow)
FONT='/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
fnt=ImageFont.truetype(FONT,int(15*K*S)); 
try: fnt.set_variation_by_name('Medium')
except Exception: pass
items=[('abstract','Abstract',(0x2c,0xe0,0x8c)),('ethereum','Ethereum',(0x8a,0x9c,0xff)),('base','Base',(0x3a,0x7b,0xff)),('bnb','BNB Chain',(0xf3,0xba,0x2f)),('apechain','ApeChain',(0x3c,0x6c,0xff)),('robinhood','Robinhood',(0xc8,0xf0,0x3c)),(None,'and more',(0x6f,0xb6,0xff))]
n=len(items); cxs=np.linspace(112,912,n); cy=1420; r=31
for (key,name,col),cx in zip(items,cxs):
    X,Y,R=cx*K*S,cy*K*S,r*K*S
    dg.ellipse([X-R*1.25,Y-R*1.25,X+R*1.25,Y+R*1.25],fill=col+(70,))
    d.ellipse([X-R,Y-R,X+R,Y+R],fill=(8,12,22,255),outline=col+(255,),width=int(2.2*K*S))
    d.ellipse([X-R+5*K*S,Y-R+5*K*S,X+R-5*K*S,Y+R-5*K*S],outline=(255,255,255,40),width=int(1*K*S))
    if key:
        lg=Image.open(f'/tmp/pst/{key}.png').convert('RGBA'); sz=int(R*1.25); lg=lg.resize((sz,sz),Image.LANCZOS); L.alpha_composite(lg,(int(X-sz/2),int(Y-sz/2)))
    else:
        for k in (-1,0,1): d.ellipse([X+k*R*0.32-R*0.07,Y-R*0.07,X+k*R*0.32+R*0.07,Y+R*0.07],fill=(220,230,255,255))
    tw=d.textlength(name,font=fnt); d.text((X-tw/2,(cy+r+12)*K*S),name,font=fnt,fill=(235,240,248,255))
glow=glow.filter(ImageFilter.GaussianBlur(10*K*S))
base.alpha_composite(glow.resize(base.size,Image.LANCZOS)); base.alpha_composite(L.resize(base.size,Image.LANCZOS))
out=base.convert('RGB'); out.save('brand/poster-real.png',optimize=True); out.save('brand/poster-real.webp',quality=88)
# showcase crop (devices)
dev=out.crop((60*K,868*K,990*K,1345*K)); dev.save('brand/poster-devices.png')
print(out.size,dev.size)
