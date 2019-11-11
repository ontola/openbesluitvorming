import * as React from "react";
import Button from "./Button";
import GlossariumAPI from "./GlossariumAPI";
import { myPersistedState } from '../helpers';


interface MState {
  selectedText?: string;
  evaluateInputText?: string;
  information?: string;
  wikipediaThumbnailUrl?: string;
  wikipediaTitle?: string;
  wikipediaReadMoreUrl?: string;
  foundOnWikipedia?: boolean;
  topicDescription?: string;
  topicAbbreviation?: string;
  topicCanonicalName?: string;
  topicSource?: string;
  customTopic?: boolean;
  loading?: boolean;
  selectingText?: boolean;
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
      wikipediaTitle: "",
      topicAbbreviation: "",
      topicCanonicalName: "",
      topicDescription: "",
      topicSource: ""
    });
    let wikipediaQuery: any;
    let customTopic: any = false;
    const inputText = this.state.evaluateInputText;
    const cleanInput = inputText && inputText.trim();

    // documentSectionAnnotations is a list of surface forms
    const documentSectionAnnotations = myPersistedState<any>("orisearch.pdfviewer.documentSectionAnnotations", []);

    if (documentSectionAnnotations.length === 0) {
      wikipediaQuery = cleanInput;
    }

    documentSectionAnnotations.map((surface_form: any) => {
      if (cleanInput && surface_form.name.toLowerCase() === cleanInput.toLowerCase()) {
        // Get top candidate
        if (surface_form.candidates[0].topic_id === null) {
          wikipediaQuery = surface_form.candidates[0].label;
        } else {
          customTopic = surface_form.candidates[0].topic_id;
          for (const candidate of surface_form.candidates) {
            if (candidate.topic_id === null) {
              wikipediaQuery = candidate.label;
              break;
            }
          }
          if (wikipediaQuery === null) {
            wikipediaQuery = cleanInput;
          }
        }
      }
    });

    if (wikipediaQuery === undefined) {
      wikipediaQuery = cleanInput;
    }

    this.glossariumAPI.getWikipediaSummary(wikipediaQuery).then((result: any) => {
      if (result) {
        // Only set thumbnail if available
        if (result.imageURL) {
          this.setState({
            wikipediaThumbnailUrl: result.imageURL,
          })
        }
        this.setState({
          foundOnWikipedia: true,
          information: result.extract,
          wikipediaReadMoreUrl: result.readmoreURL,
          wikipediaTitle: result.title,
        })
      } else {
        this.setState({
          foundOnWikipedia: false,
          information: "Onderwerp niet gevonden",
          wikipediaThumbnailUrl: "",
        });
      }
    });

    if (customTopic) {
      this.glossariumAPI.getTopic(customTopic).then((response: any) => {
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
        topicDescription: "Geen definitie in documenten gevonden."
      })
    }

  }

  onChange = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({
      evaluateInputText: e.currentTarget.value
    })
  }

  selectionChangeCallback = () => {
    if (this.state.selectingText) {
      const selection = document.getSelection();
      if (selection) {
        this.setState({
          selectedText: selection.toString(),
          evaluateInputText: selection.toString()
        });
      }
    }
  }

  selectionEnd = () => {
    document.removeEventListener('mouseup', this.selectionEnd);
    this.setState({
      selectingText: false
    });
  }

  componentDidMount() {
    document.addEventListener('selectionchange', this.selectionChangeCallback);

    const pdfViewer = document.getElementById("PDFViewer");
    if (pdfViewer) {
      pdfViewer.addEventListener('selectstart', () => {
        this.setState({
          selectingText: true
        });
        document.addEventListener('mouseup', this.selectionEnd);
      });
    }

    const glossaryDescription = document.getElementById("glossary_item_definition");
    if (glossaryDescription) {
      glossaryDescription.addEventListener('selectstart', () => {
        this.setState({
          selectingText: true
        });
        document.addEventListener('mouseup', this.selectionEnd);
      });
    }
  }

  componentWillUnmount() {
    const pdfViewer = document.getElementById("PDFViewer");
    if (pdfViewer) {
      pdfViewer.removeEventListener('selectionchange', this.selectionChangeCallback);
    }
    const glossaryDescription = document.getElementById("glossary_item_definition");
    if (glossaryDescription) {
      glossaryDescription.removeEventListener('selectionchange', this.selectionChangeCallback);
    }
    document.removeEventListener('selectionchange', this.selectionChangeCallback);
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
                  Verzenden
              </Button>
            </form>
          </div>

          {!this.state.loading && <div className="definition-container">
            <div className="definition-title">
              {this.state.customTopic == true && <b>{this.state.topicCanonicalName} + ({this.state.topicAbbreviation})</b>}
            </div>
            <div className="definition" id="glossary_item_definition">
              {this.state.customTopic == true && <a href={this.state.topicSource} target="_blank" rel="noopener noreferrer">Bron</a>}
              <p>{this.state.topicDescription}</p>
            </div>
          </div>}

          {this.state.loading && <div className="definition-container">Zoeken...</div>}

          <div className="linked-data-container">
            <div className="wiki-summary">
              {this.state.foundOnWikipedia == true && <p>{this.state.information}</p>}
              {this.state.foundOnWikipedia == false && this.state.loading && <p>Zoeken...</p>}
              {this.state.wikipediaReadMoreUrl && <p className="read-more"><a href={this.state.wikipediaReadMoreUrl} target="_blank" rel="noopener noreferrer">Lees verder op Wikipedia</a></p>}
            </div>
            <div className="descriptive-image">
              {this.state.wikipediaThumbnailUrl && <img className="wiki-image" src={this.state.wikipediaThumbnailUrl} alt={"afbeelding van " + this.state.wikipediaTitle} />}
            </div>
          </div>
        </div>
      </div>
    );
  }
}


export default Glossarium;