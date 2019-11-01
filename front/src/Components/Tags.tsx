import * as React from "react";
import { TopTags } from '../types';
import { colors } from '../sharedStyles';

const Tags = (props: {tags: TopTags | undefined}) => {
  if (!props.tags) {
    return null
  }
  try {
    return (
      <div
        style={{
          marginBottom: '.4rem',
        }}
      >
        <div style={{
          color: colors.bluedark,
          borderRadius: '5px',
          background: colors.g1,
          padding: '.1rem .2rem',
          display: 'inline',
        }}>
          {props.tags["http://www.w3.org/1999/02/22-rdf-syntax-ns#_0"]["https://argu.co/ns/meeting/tag"]}
        </div>
      </div>
    );}
  catch {
    return null
  }
};

export default Tags;
