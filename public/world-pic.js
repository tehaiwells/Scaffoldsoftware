// Home world map (public/world.js): encodes a scenery bitmap as PNG off the page's main thread. Receives {id, bmp: ImageBitmap}, answers {id, blob}
// (blob null if this browser cannot encode in a worker; the page then encodes it itself).
self.onmessage=async e=>{const {id,bmp}=e.data??{};let blob=null;
  try{const c=new OffscreenCanvas(bmp.width,bmp.height);c.getContext('2d').drawImage(bmp,0,0);blob=await c.convertToBlob({type:'image/png'});}catch{blob=null;}
  finally{try{bmp?.close();}catch{}}
  self.postMessage({id,blob});};
