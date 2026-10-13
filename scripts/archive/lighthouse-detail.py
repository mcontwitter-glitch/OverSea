# PREVIEW: add lighthouse detail/texture (pixel + 4x supersampled vector overlays). Writes brand/preview/*.
import numpy as np; from PIL import Image, ImageDraw, ImageFilter
rng=np.random.default_rng(7)
G={
 'logo':dict(src='brand/logo-src.png', body=(519,780), L=(464,560,-0.119), R=(558,560,0.115),
   stripes=[(519,555,'d'),(556,606,'w'),(607,662,'d'),(663,717,'w'),(718,779,'d')], course=8,
   lantern=(477,447,547,490), rail=(462,491,560,502), door=(737,779,20), windows=[(578,598,9),(683,703,9)], plinth=(781,806,420,602), island=None),
 'banner':dict(src='brand/banner-src.png', body=(240,382), L=(1200,280,-0.16), R=(1254,280,0.16),
   stripes=[(240,261,'d'),(262,289,'w'),(290,319,'d'),(320,349,'w'),(350,382,'d')], course=4,
   lantern=(1209,204,1246,226), rail=(1196,227,1258,232), door=(361,382,10), windows=[(268,281,5),(326,339,5)], plinth=(384,397,1176,1276), island=(1060,383,1500,450)),
}
def edges(g,y):
    l=g['L'][0]+(y-g['L'][1])*g['L'][2]; r=g['R'][0]+(y-g['R'][1])*g['R'][2]; return l,r
def smooth(a,b,x): t=np.clip((x-a)/(b-a),0,1); return t*t*(3-2*t)
def noise(h,w,scale,s=1):
    n=rng.standard_normal((max(2,h//scale+2),max(2,w//scale+2))).astype(np.float32)
    return np.array(Image.fromarray(n).resize((w,h),Image.BICUBIC))*s
def make(name,v):
    g=G[name]; im=Image.open(g['src']); alpha=np.array(im)[...,3] if im.mode=='RGBA' else None
    img=np.array(im.convert('RGB')).astype(np.float32); H,W=img.shape[:2]
    P=dict(A=dict(hi=0.06,sh=0.22,lift=18,course=0.07,joint=0.0,grain=3.5,weather=0,rock=10,draw_door=False,rail_a=150,bars=1),
           B=dict(hi=0.10,sh=0.38,lift=30,course=0.14,joint=0.10,grain=6.5,weather=0.10,rock=20,draw_door=True,rail_a=230,bars=2))[v]
    y0,y1=g['body']; Y,X=np.mgrid[0:H,0:W].astype(np.float32)
    l,r=edges(g,Y); inside=(Y>=y0)&(Y<=y1)&(X>l+1.5)&(X<r-1.5)
    u=np.clip((X-l)/np.maximum(r-l,1),0,1)
    white=np.zeros((H,W),bool); dark=np.zeros((H,W),bool)
    for a,b,t in g['stripes']:
        band=(Y>=a)&(Y<=b)&inside; (white if t=='w' else dark)[band]=True
    # cylindrical shading (light from upper-left / lamp side)
    hl=np.exp(-((u-0.27)/0.16)**2); shd=smooth(0.45,1.0,u)
    fw=(1-0.05)+P['hi']*hl-P['sh']*shd
    img[white]*=np.clip(fw[white],0,1.05)[:,None]
    img[dark]+=(P['lift']*hl[dark]-2*shd[dark])[:,None]
    # rim light near top of tower from the lamp
    rim=np.exp(-(Y-y0)/((y1-y0)*0.25))*(1-u)**0.5
    img[dark]+=(14*rim[dark])[:,None]
    # stone courses + staggered joints (follow the curvature)
    c=g['course']; row=np.floor((Y-y0)/c); fy=(Y-y0)-row*c
    line=(fy<1.0)
    theta=np.arcsin(np.clip(2*u-1,-1,1)); jstep=np.radians(22); off=(row%2)*jstep/2
    jphase=((theta+off)%jstep)/jstep; jcol=(np.minimum(jphase,1-jphase)*jstep*(r-l)/2*np.cos(theta).clip(0.15))<0.6
    m=white&line; img[m]*=1-P['course']
    if P['joint']: m=white&jcol&~line; img[m]*=1-P['joint']
    m=dark&line; img[m]+=4 if v=='A' else 7
    # grain / weathering on white stripes
    gr=rng.standard_normal((H,W)).astype(np.float32)*P['grain']+noise(H,W,6,P['grain']*0.8)
    img[white]+=gr[white][:,None]
    if P['weather']:
        st=np.clip(noise(H,W,1,1)*0+np.array(Image.fromarray(rng.standard_normal((4,W//3+2)).astype(np.float32)).resize((W,H),Image.BICUBIC)),0,None)
        img[white]*=(1-P['weather']*st[white]*(0.4+0.6*shd[white]))[:,None]
    # island rock texture (banner)
    if g['island']:
        ix0,iy0,ix1,iy1=g['island']; reg=(X>=ix0)&(X<ix1)&(Y>=iy0)&(Y<iy1)
        rgb=img; lum=rgb.mean(-1); water=(rgb[...,2]-rgb[...,0])>12
        o=np.array(Image.open('brand/banner-orig.png').convert('RGB')).astype(np.float32)
        rock=reg&(o[...,2]<62)&(lum<90)&~water&~inside
        rock=np.array(Image.fromarray(rock.astype(np.uint8)*255).filter(ImageFilter.MinFilter(3)))>0
        n=noise(H,W,3,1)*0.6+noise(H,W,9,1)*0.4+rng.standard_normal((H,W)).astype(np.float32)*0.35
        ridge=np.clip(np.abs(noise(H,W,7,1))<0.12,0,1)  # crack lines
        top=np.clip(1-(Y-iy0)/(iy1-iy0),0,1)
        val=P['rock']*(0.35+0.65*top)*np.clip(n*0.5+0.5,0,1.5)-P['rock']*0.5*ridge
        img[rock]+=val[rock][:,None]
    # vector overlays at 4x
    S=4; ov=Image.new('RGBA',(W*S,H*S),(0,0,0,0)); d=ImageDraw.Draw(ov)
    rx0,ry0,rx1,ry1=g['rail']; n_bal=11 if name=='logo' else 7
    d.line([(rx0*S,ry0*S),(rx1*S,ry0*S)],fill=(220,220,220,P['rail_a']),width=max(2,int(S*(1.2 if name=='logo' else 0.8))))
    for i in range(1,n_bal):
        t=i/n_bal; th=np.arcsin(2*t-1); xx=(rx0+rx1)/2+np.sin(th)*(rx1-rx0)/2
        d.line([(xx*S,ry0*S),(xx*S,ry1*S)],fill=(200,200,200,int(P['rail_a']*(0.5+0.5*np.cos(th)))),width=max(1,int(S*0.7)))
    lx0,ly0,lx1,ly1=g['lantern']
    for k in range(P['bars']):
        yy=ly0+(ly1-ly0)*(k+1)/(P['bars']+1); d.line([(lx0*S,yy*S),(lx1*S,yy*S)],fill=(150,150,150,140),width=max(1,int(S*0.6)))
    if v=='B':
        d.line([(lx0*S,ly0*S),(lx1*S,ly0*S)],fill=(120,120,120,170),width=int(S*1.0))
    if P['draw_door']:
        a,b,wd=g['door']; cx=(edges(g,b)[0]+edges(g,b)[1])/2-wd*0.35
        x0,x1=cx-wd/2,cx+wd/2; arc=wd/2
        d.rounded_rectangle([x0*S,a*S,x1*S,(b+0.5)*S],radius=int(arc*S),fill=(34,34,38,255),outline=(170,170,170,220),width=max(2,int(S*(1.0 if name=='logo' else 0.6))))
        d.line([((x0+x1)/2*S,(a+arc)*S),((x0+x1)/2*S,b*S)],fill=(90,90,90,200),width=max(1,int(S*0.5)))
        for ya,yb,ww in g['windows']:
            cxw=(edges(g,ya)[0]+edges(g,ya)[1])/2+ (ww*1.2 if ya==g['windows'][0][0] else -ww*1.0)
            d.rounded_rectangle([(cxw-ww/2)*S,ya*S,(cxw+ww/2)*S,yb*S],radius=int(ww*0.5*S),fill=(28,28,32,235),outline=(120,120,120,200),width=max(1,int(S*0.6)))
            d.line([((cxw-ww/2-1)*S,(yb+0.8)*S),((cxw+ww/2+1)*S,(yb+0.8)*S)],fill=(160,160,160,200),width=max(1,int(S*0.7)))
    ov=ov.resize((W,H),Image.LANCZOS)
    base=Image.fromarray(np.clip(img,0,255).astype(np.uint8)).convert('RGBA'); base.alpha_composite(ov)
    out=np.array(base)
    if alpha is not None: out[...,3]=alpha; res=Image.fromarray(out,'RGBA')
    else: res=Image.fromarray(out[...,:3])
    res.save(f'brand/preview/{name}-detail-{v}.png')
    return res
crops={'logo':(400,380,624,820),'banner':(1150,180,1310,450)}
rows=[]
for name in ['logo','banner']:
    imgs=[Image.open(G[name]['src']).convert('RGB')]+[make(name,v).convert('RGB') for v in 'AB']
    c=crops[name]; k=2 if name=='logo' else 3
    rows.append([im.crop(c).resize(((c[2]-c[0])*k,(c[3]-c[1])*k),Image.LANCZOS) for im in imgs])
from PIL import ImageFont
Wt=sum(i.width for i in rows[0])+40; Ht=rows[0][0].height+rows[1][0].height+90
cv=Image.new('RGB',(max(Wt,sum(i.width for i in rows[1])+40),Ht),'#222'); dd=ImageDraw.Draw(cv)
y=30
for rset in rows:
    x=10
    for lab,im in zip(['Before','A (subtle)','B (detailed)'],rset): cv.paste(im,(x,y)); dd.text((x+4,y-22),lab,fill='#fff'); x+=im.width+10
    y+=rset[0].height+40
cv.save('screens/lighthouse-detail-compare.png'); print(cv.size)
