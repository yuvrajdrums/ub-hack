## Summary

Rehab setup offers Lite, Full and Heavy Pose Landmarker models so Yuvraj can compare model performance while keeping the existing movement evaluator unchanged.

Lite is selected by default and uses the bundled model. Full and Heavy download versioned model files from Google when the camera starts. Inference runs locally; camera frames are not uploaded. Larger models may take longer to load and run, especially on a phone.

Changing models stops the active camera, closes its tracker and clears calibration. The user must enable the camera and capture new references. Selection is locked during a set and disabled for guided static quads. There is no fallback to another model if the selected model fails; the existing GPU-to-CPU delegate fallback remains.

This change only selects model weights. It leaves exercise geometry, tracking criteria, frame cadence and repetition thresholds at the baseline implementation. A different model may change landmark quality, but does not guarantee more accurate rep counting.

Run `npx playwright test tests/e2e/rehab-pose-models.spec.ts` to verify Lite startup and clean switching on a virtual camera. Set `CV_TEST_ALL_POSE_MODELS=1` to exercise actual Full and Heavy downloads. These checks do not validate physical exercise accuracy.
