import {cp,mkdir,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.resolve(process.argv[2]||path.join(repo,'..','hosted-phone'));
if(target===repo||target.startsWith(repo+path.sep))throw new Error('Choose a separate hosting checkout outside this repository.');
await mkdir(target,{recursive:true});
await cp(path.join(repo,'hosting'),target,{recursive:true,filter:source=>!['node_modules','.git','dist','.wrangler','.sites-runtime','.dev.vars'].includes(path.basename(source))});
for(const name of ['apps/rehab/src/app/page.tsx','apps/rehab/src/app/cv.module.css','apps/rehab/src/server/cv/service.ts','apps/rehab/src/server/cv/config.ts','apps/rehab/src/server/cv/gemini.ts','apps/rehab/src/server/cv/http.ts','packages/contracts/rehab-cv.ts','packages/platform/json-store.ts','packages/ui/theme.css']){
 const dest=path.join(target,'shared',name);await mkdir(path.dirname(dest),{recursive:true});await copyFile(path.join(repo,name),dest);
}
await cp(path.join(repo,'apps/rehab/src/features'),path.join(target,'shared/apps/rehab/src/features'),{recursive:true});
await cp(path.join(repo,'apps/rehab/src/server/cv/skills'),path.join(target,'shared/apps/rehab/src/server/cv/skills'),{recursive:true});
await cp(path.join(repo,'apps/rehab/public'),path.join(target,'public/rehab'),{recursive:true});
console.log(`Phone hosting source prepared at ${target}`);
