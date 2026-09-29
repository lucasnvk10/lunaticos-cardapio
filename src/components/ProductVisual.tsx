import { useState } from 'react';

const images: Record<string,string> = {
  chopp:'/products/cerveja.webp',cerveja:'/products/cerveja.webp',chevette:'/products/chevette.webp',
  jurupinga:'/products/jurupinga.webp','vodka-energetico':'/products/vodkaenergetico.webp',
  gummy:'/products/gummy.webp',agua:'/products/agua.webp'
};

export function ProductVisual({slug,name,emoji='🥤',className=''}:{slug:string;name:string;emoji?:string;className?:string}) {
  const [failed,setFailed]=useState(false);
  const src=images[slug];
  return src&&!failed ? <img className={className} src={src} alt={name} loading="lazy" onError={()=>setFailed(true)}/>
    : <span className={`${className} product-visual-fallback`} role="img" aria-label={name}>{emoji || '🥤'}</span>;
}
