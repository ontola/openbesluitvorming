import * as React from "react";
import GlossariumAPI from "./GlossariumAPI";
import { myPersistedState } from '../helpers';
import paths from "../paths";


interface MState {
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

interface MProps {
  selectedText?: string;
  pdfWrapperRef: React.RefObject<HTMLDivElement>;
}

class Glossarium extends React.PureComponent<MProps, MState> {
  glossariumAPI: any;
  private glossaryDiv: React.RefObject<HTMLDivElement>;
  private pdfWrapper: HTMLDivElement | null;

  constructor(props: MProps) {
    super(props);
    this.glossariumAPI = new GlossariumAPI();
    this.state = {
      information: '',
      wikipediaThumbnailUrl: '',
      wikipediaReadMoreUrl: '',
      foundOnWikipedia: undefined,
      topicDescription: '',
      topicAbbreviation: '',
      topicCanonicalName: '',
      topicSource: '',
      customTopic: false,
      loading: true,
    };
    this.glossaryDiv = React.createRef();
    this.pdfWrapper = null;
  }

  addWikipediaSumm = (queryString: string, tapiResponse: any) => {
    this.glossariumAPI.getWikipediaSummary(queryString).then((result: any) => {
      if (result) {
        // Only add if relevant
        if (tapiResponse) {
          const wikisumm = result.extract.toLowerCase();
          const toCompare = [tapiResponse.canonical_name.toLowerCase()];
          for (const name of tapiResponse.names) {
            toCompare.push(name.toLowerCase());
          }

          if (toCompare.some(name => wikisumm.includes(name))) {
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
              loading: false,
            });
            this.addPdfWrapperMargin();
            return;
          }
        } else {
          this.setState({
            foundOnWikipedia: true,
            information: result.extract,
            wikipediaReadMoreUrl: result.readmoreURL,
            wikipediaTitle: result.title,
            loading: false
          });
          this.addPdfWrapperMargin();
          return;
        }
      }
      // If no wiki is found or irrelevant..
      if (tapiResponse) {
        this.setState({
          foundOnWikipedia: false,
          information: "",
          wikipediaThumbnailUrl: "",
          wikipediaReadMoreUrl: "",
          loading: false
        });
      } else {
        this.setState({
          foundOnWikipedia: false,
          information: "Onderwerp niet gevonden",
          wikipediaThumbnailUrl: "",
          wikipediaReadMoreUrl: "",
          loading: false,
        });
      }
      this.addPdfWrapperMargin();
    });
  };

  evaluateSelection = (e?: any) => {
    e && e.preventDefault(); // Stops page on refreshing (onSubmit)
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
    const inputText = this.props.selectedText;
    const cleanInput = inputText && inputText.trim();

    // documentSectionAnnotations is a list of surface forms
    const documentSectionAnnotations = myPersistedState<any>("orisearch.pdfviewer.documentSectionAnnotations", []);

    if (documentSectionAnnotations.length === 0) {
      wikipediaQuery = cleanInput;
    }

    // Try to find topic in section annotations and determine wikipedia-query-string
    documentSectionAnnotations.map((surfaceForm: any) => {
      if (cleanInput && surfaceForm.name.toLowerCase() === cleanInput.toLowerCase()) {
        // Get top candidate
        if (surfaceForm.candidates[0].topic_id === null) {
          wikipediaQuery = surfaceForm.candidates[0].label;
        } else {
          customTopic = surfaceForm.candidates[0].topic_id;
          for (const candidate of surfaceForm.candidates) {
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

    // If topic was found set state
    // Add wikipedia summary if relevant
    if (customTopic) {
      this.glossariumAPI.getTopic(customTopic).then((response: any) => {
        let topicSource = "";
        if (response.sources.length > 0) {
          topicSource = paths.oriIdBase + response.sources[0]
        }

        this.setState({
          topicDescription: response.description,
          topicAbbreviation: response.abbreviation,
          topicCanonicalName: response.canonical_name,
          topicSource: topicSource,
          customTopic: true,
          loading: false
        });

        if (response.abbreviation) {
          wikipediaQuery = response.canonical_name;
        }

        return response
      }).then((response: any) => {
        this.addWikipediaSumm(wikipediaQuery, response);
      })
    } else {
      this.setState({
        topicAbbreviation: '',
        topicCanonicalName: '',
        topicDescription: undefined,
        topicSource: '',
        customTopic: false
      });
      this.addWikipediaSumm(wikipediaQuery, undefined);
    }
  };

  addPdfWrapperMargin() {
    const glossaryDiv = this.glossaryDiv.current;
    if (glossaryDiv && this.pdfWrapper) {
      this.pdfWrapper.style.marginBottom = `${glossaryDiv.offsetHeight}px`
    }
  }

  removePdfWrapperMargin() {
    if (this.pdfWrapper) {
      this.pdfWrapper.style.marginBottom = null
    }
  }

  componentDidMount() {
    this.pdfWrapper = this.props.pdfWrapperRef.current;
    this.evaluateSelection();
  }

  componentDidUpdate(prevProps: MProps) {
    if (prevProps.selectedText !== this.props.selectedText) {
      this.evaluateSelection();
    }
  }

  componentWillUnmount(): void {
    this.removePdfWrapperMargin()
  }

  render() {
    if (this.props.selectedText === '') {
      return (
        <div ref={this.glossaryDiv} className="Glossarium">
          Selecteer tekst
        </div>
      );
    } else {
      return (
        <div ref={this.glossaryDiv} className="Glossarium">
          <div className="glossarium-container">
            {this.state.loading ?
              <div className="definition-container">Laden...</div>
              :
              <div className="definition-container">
                <div className="definition-title">
                  {this.state.customTopic == true && <b>{this.state.topicCanonicalName} + ({this.state.topicAbbreviation})</b>}
                </div>
                <div className="definition" id="glossary_item_definition">
                  {this.state.customTopic == true && <a href={this.state.topicSource} target="_blank" rel="noopener noreferrer">Bron</a>}
                  {this.state.topicDescription &&
                    <p>{this.state.topicDescription}</p>
                  }
                </div>
              </div>
            }
            <div className="linked-data-container">
              <div className="wiki-summary">
                {this.state.wikipediaThumbnailUrl &&
                  <img
                    className="wiki-image"
                    src={this.state.wikipediaThumbnailUrl}
                    alt={"afbeelding van " + this.state.wikipediaTitle}
                  />}
                {this.state.foundOnWikipedia ?
                  <p>
                    <b>{this.state.wikipediaTitle}: </b>
                    {this.state.information}
                  </p>
                  :
                  this.state.loading ?
                    <p></p>
                    :
                    this.state.information !== "" ?
                      <p>Niets gevonden voor &quot;{this.props.selectedText}&quot;</p>
                      :
                      <p></p>
                }
                {this.state.wikipediaReadMoreUrl !== "" && <p className="read-more"><a href={this.state.wikipediaReadMoreUrl} target="_blank" rel="noopener noreferrer">Lees verder op Wikipedia</a></p>}
              </div>
            </div>
          </div>
        </div>
      );
    }
  }
}


export default Glossarium;
