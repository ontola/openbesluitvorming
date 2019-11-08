import { SERVER_PORT } from "../config";


class GlossariumAPI {
  getDocumentSectionAnnotations = async (documentName: string, pageNumber: Number, wordhoardIDs: Array<any>) => {
    let documentAnnotationsURL = new URL(window.location.origin);
    documentAnnotationsURL.port = SERVER_PORT.toString();

    documentAnnotationsURL.pathname = "/topics_api/dev/document/" + documentName + "/" + pageNumber + "/annotations/";
    for (let wid of wordhoardIDs) {
      documentAnnotationsURL.searchParams.append("wordhoard_id", wid);
    }
    console.log("getDocSecAnn:", documentAnnotationsURL.toString());
    var response = await fetch(documentAnnotationsURL.toString());
    return await response.json();
  }

  getWordhoardList = async(names: Array<any>) => {
    let wordhoardURL = new URL(window.location.origin);
    wordhoardURL.port = SERVER_PORT.toString();

    wordhoardURL.pathname = "/topics_api/dev/custom/wordhoard/";
    for (let name of names) {
      wordhoardURL.searchParams.append("name", name + "_definitions");
    }
    var response = await fetch(wordhoardURL.toString() + "/");
    return await response.json();
  }

  getTopic = async (uuid: string) => {
    let topicURL2 = new URL(window.location.origin);
    topicURL2.port = SERVER_PORT.toString();

    topicURL2.pathname = "/topics_api/dev/custom/topic/";
    var response = await fetch(topicURL2.toString());
    var json = await response.json();

    let topic = json.topics.find((topic: any) => { return topic.id == uuid})
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
    let firstPageKey = Object.keys(data.query.pages)[0]
    let page = data.query.pages[firstPageKey];
    if (firstPageKey == "-1") {
      return false;
    }
    let extract: String = page.extract;
    let imageURL = await this.getWikipediaImageURL(page.title);
    let readmoreURL = "https://nl.wikipedia.org/wiki/" + page.title;
    return [extract, imageURL, readmoreURL];
  }

  getWikipediaImageURL = async (query: String): Promise<any> => {
    const apiQuery = "https://nl.wikipedia.org/w/api.php?action=query&titles=" + query +"&prop=pageimages&format=json&origin=*&pithumbsize=200";
    var response = await fetch(apiQuery);
    var data = await response.json();
    try {
      let firstPageKey = Object.keys(data.query.pages)[0]
      let page = data.query.pages[firstPageKey];
      return page.thumbnail.source;
    } catch (e) {
      return false;
    }
  }

  getAgendaItemFromDocID = async (id: String): Promise<any> => {
    const query = "https://id.openraadsinformatie.nl/" + id + ".jsonld";
    var response = await fetch(query);
    var data = await response.json();
    try {
      return data["dc:isReferencedBy"]["@id"]
    } catch (e) {
      return false;
    }
  }
}


export default GlossariumAPI;