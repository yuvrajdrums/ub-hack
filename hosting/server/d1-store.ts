import { DomainError } from "../shared/packages/platform/json-store";
import type { CvStore, CvStoreData } from "../shared/apps/rehab/src/server/cv/service";
type Row={revision:number;payload:string};
const seed=():CvStoreData=>({sessions:[],receipts:{}});

// Each authenticated owner has a separate document. CAS prevents lost writes
// across Worker isolates; callbacks may run again and must be side-effect free.
export class D1CvStore implements CvStore {
 constructor(private db:D1Database,private key:string){}
 private row(){return this.db.prepare("SELECT revision,payload FROM cv_documents WHERE key=?1").bind(this.key).first<Row>();}
 async snapshot(){const row=await this.row();return row?JSON.parse(row.payload) as CvStoreData:seed();}
 async update<R>(fn:(state:CvStoreData)=>R|Promise<R>):Promise<R>{
  for(let attempt=0;attempt<12;attempt++){
   const row=await this.row();
   const state=row?JSON.parse(row.payload) as CvStoreData:seed();
   const result=await fn(state);
   const payload=JSON.stringify(state);
   if(new TextEncoder().encode(payload).length>1800000)throw new DomainError("DEMO_STORAGE_LIMIT","The private demo storage limit has been reached",429);
   const write=row
    ?this.db.prepare("UPDATE cv_documents SET payload=?1,revision=revision+1 WHERE key=?2 AND revision=?3").bind(payload,this.key,row.revision)
    :this.db.prepare("INSERT OR IGNORE INTO cv_documents(key,revision,payload) VALUES(?1,0,?2)").bind(this.key,payload);
   const saved=await write.run();
   if(saved.meta.changes===1)return result;
   await new Promise(resolve=>setTimeout(resolve,10+attempt*10));
  }
  throw new DomainError("STORAGE_BUSY","Concurrent update; retry with the same request ID",503);
 }
}
