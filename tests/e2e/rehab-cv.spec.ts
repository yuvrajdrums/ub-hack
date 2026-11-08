import { test,expect } from "@playwright/test";
import path from "node:path";

test.beforeEach(async({page})=>{
  // Real provider success is verified separately; browser tests never make paid calls.
  await page.route("**/api/cv/v1/sessions/*/feedback/*/generate",async route=>{
    const url=new URL(route.request().url());const match=url.pathname.match(/sessions\/([^/]+)\/feedback\/([^/]+)/)!;
    const changes=await page.request.get(`/rehab/api/cv/v1/sessions/${match[1]}/changes?after=0`);
    const data=await changes.json();const item=data.data.changes.find((c:{feedback:{eventId:string}})=>c.feedback.eventId===match[2]).feedback;
    await route.fulfill({json:{ok:true,data:{...item,generationStatus:"complete",textRevision:item.textRevision+1,fallbackReason:"browser_test_provider_double"}}});
  });
});

test("standalone trace reaches text, saves once, and survives reload",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/rehab");
  await expect(page.getByRole("heading",{name:"Every movement."})).toBeVisible();
  await page.getByText("Try a clearly labeled example trace",{exact:true}).click();
  await page.getByRole("button",{name:"Run sample movements",exact:true}).click();
  await expect(page.getByText("Simulated input",{exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Panda text feedback"})).toContainText(/hold|movement|position/i,{timeout:12000});
  await expect(page.getByRole("status")).toContainText("Simulated trace complete",{timeout:25000});
  await expect(page.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow","1");
  await page.screenshot({path:path.resolve("../../outputs/Panda Care/demo-desktop.png"),fullPage:true});
  await page.getByRole("button",{name:"Pause",exact:true}).click();
  await expect(page.getByRole("button",{name:"Resume",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Resume",exact:true}).click();
  let lostFinish=false;
  await page.route("**/api/cv/v1/sessions/*/finish",async route=>{
    if(!lostFinish){lostFinish=true;await route.fetch();await route.abort("failed");}
    else await route.continue();
  });
  await page.getByRole("button",{name:"Finish and save",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry save",exact:true})).toBeVisible({timeout:15000});
  await page.getByRole("button",{name:"Retry save",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("Report saved once",{timeout:15000});
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toContainText("2 movements · 1 met targets");
  await expect(page.getByRole("article")).toContainText("simulated");
  await page.reload();await expect(page.getByRole("article")).toHaveCount(1);
  expect(errors).toEqual([]);
});

for(const exerciseId of ["straight-leg-raise","seated-knee-flexion-extension"]){
  test(`${exerciseId} uses its own trace protocol and persists a truthful result`,async({page})=>{
    await page.goto("/rehab");await page.getByLabel("Exercise",{exact:true}).selectOption(exerciseId);
    await page.getByText("Try a clearly labeled example trace",{exact:true}).click();
    await page.getByRole("button",{name:"Run sample movements",exact:true}).click();
    await expect(page.getByRole("status")).toContainText("Simulated trace complete",{timeout:35000});
    await expect(page.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow","1");
    await page.getByRole("button",{name:"Finish and save",exact:true}).click();
    await expect(page.getByRole("status")).toContainText("Report saved once",{timeout:15000});
    await expect(page.getByRole("article")).toContainText("2 movements · 1 met targets");
  });
}

test("static quads records patient confirmation without camera evidence",async({page})=>{
  await page.goto("/rehab");await page.getByLabel("Exercise",{exact:true}).selectOption("static-quads");
  await page.getByRole("button",{name:"Start set",exact:true}).click();
  await page.getByRole("button",{name:"Start guided hold",exact:true}).click();
  await page.waitForTimeout(5200);
  await page.getByRole("button",{name:"Confirm this hold",exact:true}).click();
  await expect(page.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow","1");
  await page.getByRole("button",{name:"Finish and save",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("Report saved once",{timeout:15000});
  await expect(page.getByRole("article")).toContainText("patient reported");
  await expect(page.getByRole("article")).toContainText("Active 0:00");
});

test("small screen stays within viewport and denied camera recovers",async({page})=>{
  await page.setViewportSize({width:375,height:812});await page.goto("/rehab");
  await expect(page.getByRole("button",{name:"Enable camera",exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole("button",{name:"Enable camera",exact:true}).click();
  await expect(page.locator("[aria-label='Live exercise camera']")).toContainText(/denied|permission|not found|could not|unavailable/i,{timeout:15000});
  await page.getByRole("button",{name:"Stop camera",exact:true}).click();
  await expect(page.getByText("Camera off",{exact:true})).toBeVisible();
  await page.screenshot({path:path.resolve("../../outputs/Panda Care/demo-mobile.png"),fullPage:true});
});

test("actual pinned pose model runs on a virtual camera and stops cleanly",async({page,context})=>{
  await context.grantPermissions(["camera"]);await page.goto("/rehab");
  await page.getByRole("button",{name:"Enable camera",exact:true}).click();
  await expect(page.getByText(/GPU ·|CPU ·/)).toBeVisible({timeout:45000});
  await expect(page.getByText("Camera on",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Stop camera",exact:true}).click();
  await expect(page.getByText("Camera off",{exact:true})).toBeVisible();
  expect(await page.locator("video").evaluate((video:HTMLVideoElement)=>video.srcObject)).toBeNull();
});

test("exercise and working-leg changes stop the old camera profile before new calibration",async({page,context})=>{
  await context.grantPermissions(["camera"]);await page.goto("/rehab");
  await expect(page.getByText(/Your upper body and opposite leg are not required/).first()).toBeVisible();
  await page.getByRole("button",{name:"Enable camera",exact:true}).click();
  await expect(page.getByText(/GPU ·|CPU ·/)).toBeVisible({timeout:45000});
  await page.getByRole("combobox",{name:"Exercise",exact:true}).selectOption("straight-leg-raise");
  await expect(page.getByText("Camera off",{exact:true})).toBeVisible();
  expect(await page.locator("video").evaluate((video:HTMLVideoElement)=>video.srcObject)).toBeNull();
  await expect(page.getByText(/includes your left shoulder, hip, knee and ankle/).first()).toBeVisible();
  await page.getByRole("combobox",{name:"Working leg",exact:true}).selectOption("right");
  await expect(page.getByText(/includes your right shoulder, hip, knee and ankle/).first()).toBeVisible();
  await expect(page.getByRole("button",{name:"Start set",exact:true})).toBeDisabled();
  await page.getByRole("combobox",{name:"Exercise",exact:true}).selectOption("static-quads");
  await expect(page.getByRole("button",{name:"Enable camera",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Start set",exact:true})).toBeEnabled();
});
