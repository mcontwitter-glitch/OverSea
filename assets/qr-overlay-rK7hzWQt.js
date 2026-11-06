const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/browser-BjhosWCW.js","assets/rolldown-runtime-C_s2cVnS.js"])))=>i.map(i=>d[i]);
import{o as e}from"./rolldown-runtime-C_s2cVnS.js";import{t}from"./preload-helper-BLdHbfdN.js";var n;function r(e,t={}){let{qrSize:r=280,showCloseButton:a=!0,closeButtonText:o=`×`,theme:s=`light`,container:c=document.body,onCancel:l}=t;n?.();let u=document.createElement(`div`);u.style.cssText=`
    position: fixed;
    inset: 0;
    background-color: ${s===`dark`?`rgba(0, 0, 0, 0.8)`:`rgba(0, 0, 0, 0.5)`};
    backdrop-filter: blur(10px);
    z-index: 9999;
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 300ms ease-out;
  `,t.overlayStyles&&Object.assign(u.style,t.overlayStyles);let d=document.createElement(`div`);if(d.style.cssText=`
    background: ${s===`dark`?`#1f1f1f`:`#ffffff`};
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    max-width: 90vw;
    max-height: 90vh;
    position: relative;
    animation: scaleIn 300ms ease-out;
  `,t.modalStyles&&Object.assign(d.style,t.modalStyles),a){let e=document.createElement(`button`);e.textContent=o,e.style.cssText=`
      position: absolute;
      top: 16px;
      right: 16px;
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: ${s===`dark`?`#ffffff`:`#000000`};
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      transition: background-color 0.2s;
    `,e.addEventListener(`mouseenter`,()=>{e.style.backgroundColor=s===`dark`?`rgba(255, 255, 255, 0.1)`:`rgba(0, 0, 0, 0.1)`}),e.addEventListener(`mouseleave`,()=>{e.style.backgroundColor=`transparent`}),e.addEventListener(`click`,()=>{b(!0)}),d.appendChild(e)}let f=document.createElement(`div`);f.style.cssText=`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  `;let p=document.createElement(`h3`);p.textContent=`Scan to Connect`,p.style.cssText=`
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: ${s===`dark`?`#ffffff`:`#000000`};
    text-align: center;
  `;let m=document.createElement(`canvas`);m.width=r,m.height=r,m.style.cssText=`
    border: 1px solid ${s===`dark`?`#333333`:`#e5e5e5`};
    border-radius: 12px;
  `,i(e,m,r).catch(console.error);let h=document.createElement(`button`);h.textContent=`Copy URI`,h.style.cssText=`
    background: ${s===`dark`?`#333333`:`#f5f5f5`};
    border: 1px solid ${s===`dark`?`#444444`:`#e5e5e5`};
    color: ${s===`dark`?`#ffffff`:`#000000`};
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s;
  `,h.addEventListener(`click`,async()=>{try{await navigator.clipboard.writeText(e);let t=h.textContent;h.textContent=`Copied!`,setTimeout(()=>{h.textContent=t},2e3)}catch(e){console.error(`Failed to copy URI:`,e)}}),f.appendChild(p),f.appendChild(m),f.appendChild(h),d.appendChild(f),u.appendChild(d);let g=document.createElement(`style`);g.textContent=`
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes fadeOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    @keyframes scaleIn {
      from { transform: scale(0.9); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes scaleOut {
      from { transform: scale(1); opacity: 1; }
      to { transform: scale(0.9); opacity: 0; }
    }
  `,document.head.appendChild(g);let _=e=>{e.key===`Escape`&&b(!0)},v=e=>{e.target===u&&b(!0)};document.addEventListener(`keydown`,_),u.addEventListener(`click`,v),c.appendChild(u);function y(){document.removeEventListener(`keydown`,_),u.removeEventListener(`click`,v),u.remove(),g.remove(),n===y&&(n=void 0)}n=y;function b(e=!1){document.removeEventListener(`keydown`,_),u.removeEventListener(`click`,v),n===y&&(n=void 0),e&&l&&l(),u.style.animation=`fadeOut 200ms ease-in`,d.style.animation=`scaleOut 200ms ease-in`;let t=()=>{u.parentNode&&u.parentNode.removeChild(u),g.parentNode&&g.parentNode.removeChild(g)};u.addEventListener(`animationend`,t,{once:!0}),setTimeout(t,250)}function x(){u.style.display=`none`}function S(){u.style.display=`flex`}return{destroy:()=>b(!1),hide:x,show:S}}async function i(n,r,i){if(!r.getContext(`2d`))return;let{toCanvas:a}=await t(async()=>{let{toCanvas:t}=await import(`./browser-BjhosWCW.js`).then(t=>e(t.default,1));return{toCanvas:t}},__vite__mapDeps([0,1]));await a(r,n,{width:i,margin:2,color:{dark:`#000000`,light:`#ffffff`}})}export{r as createQROverlay};