export interface ORIItemType {
  _id: string;
  _score: number;
  _index: string;
  _type: string;
  // TODO: specify?
  _source: any;
  _version?: number;
  _explanation?: any;
  content_type: string;
  date_modified: string;
  fields?: any;
  highlight?: any;
  hightlight: string;
  inner_hits?: any;
  matched_queries?: string[];
  name: string;
  original_url: string;
  size_in_bytes: string;
  sort?: string[];
  text: string;
  title: string;
}
