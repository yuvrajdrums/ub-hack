import {test,expect} from "@playwright/test";
import {POSE_MODELS} from "../../apps/rehab/src/features/camera/pose-models";

for(const model of POSE_MODELS){
  test(`${model.label} pose model loads its selected weights and switching stops the camera`,async({page,context})=>{
    test.skip(model.id!=="lite"&&process.env.CV_TEST_ALL_POSE_MODELS!=="1","Full/Heavy startup checks opt into Google's model downloads.");
    test.setTimeout(120000);
    await context.grantPermissions(["camera"]);
    await page.goto("/rehab");
    const picker=page.getByRole("combobox",{name:"Pose model",exact:true});
    await expect(picker).toBeEnabled();
    await picker.selectOption(model.id);
    const requests:string[]=[];
    page.on("request",request=>requests.push(request.url()));
    await page.getByRole("button",{name:"Enable camera",exact:true}).click();
    await expect(page.getByText(/GPU ·|CPU ·/)).toBeVisible({timeout:100000});
    await expect(page.getByText("Camera on",{exact:true})).toBeVisible();
    expect(requests.some(url=>url.endsWith(model.assetPath))).toBe(true);
    await picker.selectOption(model.id==="lite"?"full":"lite");
    await expect(page.getByText("Camera off",{exact:true})).toBeVisible();
    expect(await page.locator("video").evaluate((video:HTMLVideoElement)=>video.srcObject)).toBeNull();
    await expect(page.getByRole("button",{name:"Start set",exact:true})).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("capture new references");
  });
}
