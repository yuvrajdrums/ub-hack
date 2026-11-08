## Summary

The exercise setup offers Lite, Full and Heavy Pose Landmarker models. Lite remains the default and uses the existing bundled model. Full and Heavy load Google's versioned float16/1 model files when the camera starts. All models use the selected exercise/side profile and run inference locally in the browser.

The model registry lives in `apps/rehab/src/features/camera/pose-models.ts`. Remote model downloads do not upload camera frames. Heavy is served from Google's download endpoint rather than being added as a large static hosting asset. The current local asset checksum manifest still covers the bundled Lite model and WASM runtime.

Changing the model stops the camera, releases the previous tracker and clears reference calibration. Model changes are disabled while a set is running or starting. Starting again loads the chosen model, with the same GPU-to-CPU delegate fallback; there is no silent fallback to a different model. Guided static quads disables the model picker because it does not use pose verification.

Larger models can take longer to download and process frames. The existing live tracking freshness rules still apply; a larger model is not guaranteed to improve rep counting on every device. Select Lite again if the device cannot maintain usable updates.

Run `npx playwright test tests/e2e/rehab-pose-models.spec.ts` for the bundled Lite startup and switching check. Set `CV_TEST_ALL_POSE_MODELS=1` to also verify the actual Full and Heavy downloads. Tests use the real model runtime on a virtual camera; they do not claim physical exercise accuracy. Full/Heavy network checks are opt-in so the routine browser suite does not depend on third-party downloads.

Official model source: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker
