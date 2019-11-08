import { SERVER_PORT } from "../config";


class GlossariumAPI {
  getDocumentSectionAnnotations = async (documentName: string, pageNumber: number, wordhoardIDs: Array<any>) => {
    const documentAnnotationsURL = new URL(window.location.origin);
    documentAnnotationsURL.port = SERVER_PORT.toString();

    documentAnnotationsURL.pathname = "/topics_api/dev/document/" + documentName + "/" + pageNumber + "/annotations/";
    for (const wid of wordhoardIDs) {
      documentAnnotationsURL.searchParams.append("wordhoard_id", wid);
    }
    console.log("getDocSecAnn:", documentAnnotationsURL.toString());
    let response = await fetch(documentAnnotationsURL.toString());
    return await response.json();
  }

  getWordhoardList = async(names: any[]) => {
    const wordhoardURL = new URL(window.location.origin);
    wordhoardURL.port = SERVER_PORT.toString();

    wordhoardURL.pathname = "/topics_api/dev/custom/wordhoard/";
    for (const name of names) {
      wordhoardURL.searchParams.append("name", name + "_definitions");
    }
    let response = await fetch(wordhoardURL.toString() + "/");
    return await response.json();
  }

  getTopic = async (uuid: string) => {
    // Get the whole list and find it, because of unknown issue.
    const topicURL2 = new URL(window.location.origin);
    topicURL2.port = SERVER_PORT.toString();

    topicURL2.pathname = "/topics_api/dev/custom/topic/";
    let response = await fetch(topicURL2.toString());
    let json = await response.json();

    const topic = json.topics.find((topic: any) => { return topic.id == uuid})
    return topic;
    // console.log(topic);

    // let topicURL = new URL(window.location.origin);
    // topicURL.port = SERVER_PORT.toString();

    // topicURL.pathname = "/topics_api/dev/custom/topic/" + uuid;
    // var response = await fetch(topicURL.toString());
    // return await response.json();
  }

  getWikipediaSummary = async (query: string): Promise<any> => {
    const apiQuery = "https://nl.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&exintro&explaintext&origin=*&format=json&titles=" + query;
    var response = await fetch(apiQuery);
    var data = await response.json();
    const firstPageKey = Object.keys(data.query.pages)[0]
    const page = data.query.pages[firstPageKey];
    if (firstPageKey == "-1") {
      return false;
    }
    let extract: string = page.extract;
    const imageURL = await this.getWikipediaImageURL(page.title);
    const readmoreURL = "https://nl.wikipedia.org/wiki/" + page.title;
    return [extract, imageURL, readmoreURL];
  }

  getWikipediaImageURL = async (query: string): Promise<any> => {
    const apiQuery = "https://nl.wikipedia.org/w/api.php?action=query&titles=" + query +"&prop=pageimages&format=json&origin=*&pithumbsize=200";
    let response = await fetch(apiQuery);
    let data = await response.json();
    try {
      const firstPageKey = Object.keys(data.query.pages)[0]
      const page = data.query.pages[firstPageKey];
      return page.thumbnail.source;
    } catch (e) {
      return false;
    }
  }

  getAgendaItemFromDocID = async (id: string): Promise<any> => {
    const query = "https://id.openraadsinformatie.nl/" + id + ".jsonld";
    const response = await fetch(query);
    const data = await response.json();
    try {
      return data["dc:isReferencedBy"]["@id"]
    } catch (e) {
      return false;
    }
  }
}


export default GlossariumAPI;