import { topTag, TopTags } from "../types.ts";
import { colors } from "../sharedStyles.ts";

const Tags = (props: { tags: TopTags | undefined }) => {
  if (!props.tags) {
    return null;
  }
  try {
    return (
      <div
        style={{
          marginBottom: ".4rem",
        }}
      >
        <div
          style={{
            color: colors.bluedark,
            borderRadius: "5px",
            background: colors.g1,
            padding: ".1rem .2rem",
            display: "inline",
          }}
        >
          {props.tags[topTag]["https://argu.co/ns/meeting/tag"]}
        </div>
      </div>
    );
  } catch {
    return null;
  }
};

export default Tags;
