import { Composition, registerRoot } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { StudioFixture, validateRenderManifest } from "./composition.js";
import type { StudioFixtureProps } from "./composition.js";

export const STUDIO_FIXTURE_COMPOSITION_ID = "StudioFixture";

export const calculateFixtureMetadata: CalculateMetadataFunction<StudioFixtureProps> = ({ props }) => {
  const manifest = validateRenderManifest(props.manifest);
  return {
    durationInFrames: manifest.scenes.reduce((total, scene) => total + scene.durationFrames, 0),
    fps: manifest.fps,
    width: manifest.width,
    height: manifest.height,
  };
};

export function RemotionRoot() {
  return (
    <Composition
      id={STUDIO_FIXTURE_COMPOSITION_ID}
      component={StudioFixture}
      defaultProps={{}}
      calculateMetadata={calculateFixtureMetadata}
    />
  );
}

registerRoot(RemotionRoot);
