"""트레이 아이콘 — 먹물 얼굴 (P8, D-50). 먹물 그림(`src/assets/cats/mukmul/`)의 색 · 생김새를 따서 16~32px 에서 읽히게 단순하게 그린다.

쉬는 중 = 감은 눈, 일하는 중 = 뜬 눈 + 주황 점, 기다림 = 뜬 눈 + 노란 점. 어두운 작업 표시줄에서도 보이게 크림색 테두리.

쓰기: python tray_icons.py <미리보기 폴더> [src-tauri/icons/tray]
"""
import sys
from PIL import Image, ImageDraw, ImageFilter
S, OUT = sys.argv[1], (sys.argv[2] if len(sys.argv)>2 else None)
FUR=(78,68,60,255); LINE=(74,34,8,255); PINK=(248,168,160,255); EYE=(250,204,72,255)
CREAM=(255,246,232,255); ORANGE=(232,96,47,255); AMBER=(255,194,51,255); INK=(59,47,42,255)
N=512; W=24  # 테 굵기

def ear(d, pts, inner):
    d.polygon(pts, fill=FUR, outline=LINE, width=W)
    d.line(pts+[pts[0]], fill=LINE, width=W, joint="curve")
    d.polygon(inner, fill=PINK)

def face(eyes):
    im=Image.new("RGBA",(N,N),(0,0,0,0)); d=ImageDraw.Draw(im)
    # 귀 (조금 둥근 끝 — 굵은 테의 joint 로)
    ear(d,[(70,250),(96,48),(232,150)],[(108,210),(116,104),(196,160)])
    ear(d,[(442,250),(416,48),(280,150)],[(404,210),(396,104),(316,160)])
    # 머리: 가로 1.25 배 타원
    box=[34,118,478,474]
    d.ellipse(box, fill=FUR, outline=LINE, width=W)
    # 귀 아래 테 겹침 가리기: 머리를 다시 칠하고 테만
    inner=[box[0]+W,box[1]+W,box[2]-W,box[3]-W]
    d.ellipse(inner, fill=FUR)
    # 눈 (얼굴 60% 아래쯤, 넓게)
    ey=318
    if eyes=="open":
        for cx in (168,344):
            d.ellipse([cx-34,ey-38,cx+34,ey+38], fill=EYE)
    else:
        for cx in (168,344):
            d.arc([cx-44,ey-40,cx+44,ey+36], 20, 160, fill=EYE, width=22)
    # 코 · 입 (작게 — 32px 에선 거의 안 보임)
    d.polygon([(242,372),(270,372),(256,388)], fill=PINK)
    return im

def halo(im, px=16):
    a=im.split()[3].filter(ImageFilter.MaxFilter(px*2+1))
    rim=Image.new("RGBA",im.size,CREAM); rim.putalpha(a)
    rim.alpha_composite(im); return rim

def dot(im,color,ring):
    im=im.copy(); d=ImageDraw.Draw(im)
    r=76; cx=cy=N-r-2; gap=22
    d.ellipse([cx-r-gap,cy-r-gap,cx+r+gap,cy+r+gap],fill=(0,0,0,0))
    d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=color,outline=ring,width=22)
    return im

def make():
    out={}
    for st in ["idle","working","waiting"]:
        f=face("closed" if st=="idle" else "open")
        pad=Image.new("RGBA",(N,N),(0,0,0,0)); pad.alpha_composite(f.resize((470,470),Image.LANCZOS),(21,30))
        h=halo(pad)
        if st=="working": h=dot(h,ORANGE,CREAM)
        if st=="waiting": h=dot(h,AMBER,INK)
        out[st]=h
    return out

icons=make()
rows=[]
for bg in [(243,243,243,255),(32,32,32,255),(0,95,184,255)]:
    row=Image.new("RGBA",(390,52),bg)
    for c,st in enumerate(["idle","working","waiting"]):
        x=c*130+6
        for px in [16,20,32]:
            row.alpha_composite(icons[st].resize((px,px),Image.LANCZOS),(x,(52-px)//2)); x+=px+10
    rows.append(row)
pv=Image.new("RGBA",(390,52*len(rows)))
for i,r in enumerate(rows): pv.paste(r,(0,i*52))
pv.resize((pv.width*3,pv.height*3),Image.NEAREST).save(f"{S}/preview-c.png")
icons["working"].resize((256,256),Image.LANCZOS).save(f"{S}/c-big.png")
if OUT:
    for st,im in icons.items():
        im.resize((32,32),Image.LANCZOS).save(f"{OUT}/tray-{st}.png",optimize=True)
        im.resize((64,64),Image.LANCZOS).save(f"{OUT}/tray-{st}@2x.png",optimize=True)
