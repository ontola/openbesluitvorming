import * as React from "react";
import Button from "./Button";
import GlossariumAPI from "./GlossariumAPI";
import { myPersistedState } from '../helpers';


interface MState {
  selectedText?: string;
  evaluateInputText?: string;
  information?: string;
  wikipediaThumbnailUrl?: string;
  wikipediaReadMoreUrl?: string;
  foundOnWikipedia?: boolean;
  topicDescription?: string;
  topicAbbreviation?: string;
  topicCanonicalName?: string;
  topicSource?: string;
  customTopic?: boolean;
  loading?: boolean;
}

class Glossarium extends React.PureComponent<{}, MState> {
  glossariumAPI: any;

  constructor(props: {}) {
    super(props);
    this.glossariumAPI = new GlossariumAPI();
    this.state = {
      evaluateInputText: '',
      selectedText: '',
      information: '',
      wikipediaThumbnailUrl: '',
      wikipediaReadMoreUrl: '',
      foundOnWikipedia: undefined,
      topicDescription: '',
      topicAbbreviation: '',
      topicCanonicalName: '',
      topicSource: '',
      customTopic: false,
      loading: false
    }
  }

  // TODO: don't make text selection work everywhere, only in pdf reader text.
  // TODO: remove old data when new query
  evaluateSelection = (e: any) => {
    e.preventDefault(); // Stops page on refreshing (onSubmit)
    this.setState({
      loading: true,
      foundOnWikipedia: false,
      information: "",
      wikipediaReadMoreUrl: "",
      wikipediaThumbnailUrl: "",
      topicAbbreviation: "",
      topicCanonicalName: "",
      topicDescription: "",
      topicSource: ""
    });
    let wikipediaQuery: any;
    let customTopic: any = false;
    const inputText = this.state.evaluateInputText;

    // documentSectionAnnotations is a list of surface forms
    const documentSectionAnnotations = myPersistedState<any>("orisearch.pdfviewer.documentSectionAnnotations", []);

    if (documentSectionAnnotations.length == 0) {
      wikipediaQuery = inputText;
    }

    documentSectionAnnotations.map((surface_form: any) => {
      if (surface_form.name == inputText) {
        // Get top candidate
        if (surface_form.candidates[0].topic_id == null) {
          wikipediaQuery = surface_form.candidates[0].label;
        } else {
          customTopic = surface_form.candidates[0].topic_id;
          for (const candidate of surface_form.candidates) {
            if (candidate.topic_id == null) {
              wikipediaQuery = candidate.label;
              break;
            }
          }
          if (wikipediaQuery == null) {
            wikipediaQuery = inputText;
          }
        }
      }
    });

    if (wikipediaQuery == undefined) {
      wikipediaQuery = inputText;
    }

    this.glossariumAPI.getWikipediaSummary(wikipediaQuery).then((result: any) => {
      console.log(wikipediaQuery, result);
      if (result) {
        // Only set thumbnail if available

        if (result[1]) {
          this.setState({
            wikipediaThumbnailUrl: result[1],
          })
        }

        this.setState({
          foundOnWikipedia: true,
          information: result[0],
          wikipediaReadMoreUrl: result[2]
        })
      } else {
        this.setState({
          foundOnWikipedia: false,
          information: "Did not find topic",
          wikipediaThumbnailUrl: "",
        });
      }
    });

    console.log(customTopic);

    if (customTopic) {
      this.glossariumAPI.getTopic(customTopic).then((response: any) => {
        console.log(response);
        let topicSource = "";
        if (response.sources.length > 0) {
          topicSource = "https://id.openraadsinformatie.nl/" + response.sources[0]
        }

        this.setState({
          topicDescription: response.description,
          topicAbbreviation: response.abbrevation,
          topicCanonicalName: response.canonical_name,
          topicSource: topicSource,
          customTopic: true,
          loading: false
        });
      })
    } else {
      this.setState({
        loading: false,
        topicDescription: "Geen custom topic gevonden."
      })
    }

  }

  onChange = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({
      evaluateInputText: e.currentTarget.value
    })
  }

  componentDidMount() {
    //let pdfViewer = document.getElementsByClassName("PDFViewer");
    document.addEventListener('selectionchange', this.updateSelection);
    this.updateSelection();
  }

  updateSelection = () => {
    let sel = {};
    
    const selected = document.getSelection();
    if (selected !== null) {
      sel = selected;
    }

    if (sel.toString() !== '') {
      this.setState({
        selectedText: sel.toString(),
        evaluateInputText: sel.toString()
      })
    }
  }


  render() {
    return (
      <div className="Glossarium">
        <div className="glossarium-container">
          <div className="selection-container">
            <h1>Huidige selectie</h1>
            <form onSubmit={this.evaluateSelection}>
              <input 
                className="selected-text"
                value={this.state.evaluateInputText}
                onChange={this.onChange}/>   
              <Button className="evaluate-selection-button">
                  Evaluate
              </Button>
            </form>
          </div>

          {!this.state.loading && <div className="definition-container">
            <div className="definition-title">
              {this.state.customTopic == true && <b>{this.state.topicCanonicalName} + ({this.state.topicAbbreviation})</b>}
            </div>
            <div className="definition">
              {this.state.customTopic == true && <a href={this.state.topicSource}>Bron</a>}
              <p>{this.state.topicDescription}</p>
            </div>
          </div>}

          {this.state.loading && <div className="definition-container">Zoeken...</div>}

          <div className="linked-data-container">
            <div className="wiki-summary">
              {this.state.foundOnWikipedia == true && <p>{this.state.information}</p>}
              {this.state.foundOnWikipedia == false && this.state.loading && <p>Zoeken...</p>}
              {this.state.wikipediaReadMoreUrl && <p className="read-more"><a href={this.state.wikipediaReadMoreUrl} target="_blank" rel="noopener noreferrer">View on wikipedia</a></p>}
            </div>
            <div className="descriptive-image">
              <img className="wiki-image" src={this.state.wikipediaThumbnailUrl}></img>
            </div>
          </div>
        </div>
      </div>
    );
  }
}


export default Glossarium;