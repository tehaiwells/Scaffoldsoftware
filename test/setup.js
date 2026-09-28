// Preloaded into every unit-test process by npm test (node --import ./test/setup.js --test ...). The tests register and sign in about 530 throwaway
// users, and scrypt at Node's default cost (N=16384, about 40 ms a hash) was a third of the suite's CPU. Here the default cost drops to N=1024
// (about 3 ms): register, login and the unknown-user check still run the same salted scrypt and timingSafeEqual in src/service.js, and a cost
// the caller passes (N or cost) still wins. Only the unit tests load this; npm start and the browser tests' server hash passwords at the production cost.
import { createRequire, syncBuiltinESMExports } from 'node:module';
const crypto=createRequire(import.meta.url)('node:crypto'),scryptSync=crypto.scryptSync;
crypto.scryptSync=(password,salt,keylen,options)=>scryptSync(password,salt,keylen,options?.N??options?.cost?options:{N:1024,...options});syncBuiltinESMExports();// the named import in src/service.js follows
