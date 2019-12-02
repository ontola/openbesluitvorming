import { getTopicsApiURL } from "../helpers";


class GlossariumAPI {
  getDocumentSectionAnnotations = async (documentName: string, sectionNumber: number, wordhoardIDs: string[]) => {
    const documentAnnotationsURL = getTopicsApiURL(
      `/document/${documentName}/${sectionNumber}/annotations/`);
    for (const wid of wordhoardIDs) {
      documentAnnotationsURL.searchParams.append("wordhoard_id", wid);
    }
    try {
      const response = await fetch(documentAnnotationsURL.toString());
      return await response.json();
    } catch(e) {
      return {surface_forms: []}
    }
  };

  getWordhoardList = async(names: string[]) => {
    // TODO: this call should only be done when a new document is selected
    const wordhoardURL = getTopicsApiURL("/custom/wordhoard/");
    for (const name of names) {
      wordhoardURL.searchParams.append("name", name);
    }
    try {
      const response = await fetch(wordhoardURL.toString());
      return await response.json();
    } catch(e) {
      return {items: []};
    }
  };

  getTopic = async (uuid: string) => {
    const topicURL = getTopicsApiURL(`/custom/topic/${uuid}/`);
    const response = await fetch(topicURL.toString());
    return await response.json();
  };

  getWikipediaSummary = async (query: string): Promise<any> => {
    const apiQuery = `https://nl.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&exintro&explaintext&origin=*&format=json&titles=${query}`;
    try {
      const response = await fetch(apiQuery);
      const data = await response.json();
      const firstPageKey = Object.keys(data.query.pages)[0];
      const page = data.query.pages[firstPageKey];
      if (firstPageKey == "-1") {
        return false;
      }
      const extract: string = page.extract;
      const imageURL = await this.getWikipediaImageURL(page.title);
      const readmoreURL = "https://nl.wikipedia.org/wiki/" + page.title;
      return {
        extract: extract,
        imageURL: imageURL,
        readmoreURL: readmoreURL,
        title: page.title,
      }
    } catch(e) {
      return false;
    }
  };

  getWikipediaImageURL = async (query: string): Promise<any> => {
    const apiQuery = `https://nl.wikipedia.org/w/api.php?action=query&titles=${query}&prop=pageimages&format=json&origin=*&pithumbsize=200`;
    const response = await fetch(apiQuery);
    const data = await response.json();
    try {
      const firstPageKey = Object.keys(data.query.pages)[0];
      const page = data.query.pages[firstPageKey];
      return page.thumbnail.source;
    } catch (e) {
      return false;
    }
  };

  findSuperItems = async (documentID: string): Promise<any> => {
    let parentORID;
    let parentData;
    let committeeORID;
    let grandparentORID;
    let meetingItemData;

    try {
      const docJson = await this.getLinkedData(documentID);
      parentORID = docJson["dc:isReferencedBy"]["@id"].split(":")[1];
    } catch(e) {
      return [null, null, null];
    }

    try {
      parentData = await this.getLinkedData(parentORID);
    } catch(e) {
      return [parentORID, null, null];
    }

    try {
      committeeORID = parentData["meeting:committee"]["@id"].split(":")[1];
    } catch(e) {
      committeeORID = null;
    }

    try {
      grandparentORID = parentData["schema:superEvent"]["@id"].split(":")[1];
    } catch(e) {
      return [parentORID, null, committeeORID];
    }

    try {
      meetingItemData = await this.getLinkedData(grandparentORID);
      committeeORID = meetingItemData["meeting:committee"]["@id"].split(":")[1];
    } catch(e) {
      return [parentORID, grandparentORID, null];
    }

    return [parentORID, grandparentORID, committeeORID];
  };

  getLinkedData = async (id: string): Promise<any> => {
    const query = `https://id.openraadsinformatie.nl/${id}.jsonld`;
    try {
      const response = await fetch(query);
      return await response.json()
    } catch(e) {
      throw("item orid:" + id + " did not resolve.")
    }
  }
}

export default GlossariumAPI;
