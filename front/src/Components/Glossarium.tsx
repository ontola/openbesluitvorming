import * as React from "react";
import Button from "./Button";
import { SERVER_PORT } from "../config";

//@ts-ignore: Untyped import
// import wikipedia from 'wikipedia-js';

interface MState {
  selectedText?: string;
  evaluateInputText?: string;
  information?: string;
  wikipediaThumbnailUrl?: string;
  wikipediaReadMoreUrl?: string;
  foundOnWikipedia?: boolean;
}

class Glossarium extends React.PureComponent<{}, MState> {
  constructor(props: {}) {
    super(props);
    this.state = {
      evaluateInputText: '',
      selectedText: '',
      information: '',
      wikipediaThumbnailUrl: '',
      wikipediaReadMoreUrl: '',
      foundOnWikipedia: undefined
    }
  }

  evaluateSelection = (e: any) => {
    e.preventDefault(); // Stops page on refreshing (onSubmit)
    const query = this.state.evaluateInputText;
    const endpoint = "https://nl.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&exintro&explaintext&origin=*&format=json&titles=" + query;

    // const endpoint = "https://en.wikipedia.org/w/api.php?action=query&list=search&prop=info&inprop=url&utf8=&format=json&origin=*&srlimit=20&srsearch=" + query;

    const url = new URL(window.location.origin);
    url.pathname = "/topics_api/dev/custom"
    url.port = SERVER_PORT.toString();
    console.log(url.toString());

    fetch(url.toString()).then(response => {
      console.log(response);
      return response.json();
    }).then(data => {
      console.log(data);
    }).catch(error => {
      console.log(error);
    })


    fetch(endpoint).then(function (response) {
      return response.json();
    }).then(data => {
      const page = data.query.pages[Object.keys(data.query.pages)[0]];
      if (Object.keys(data.query.pages)[0] == "-1") {
        this.setState({
          foundOnWikipedia: false
        });
        return
      }
      const extract = page.extract;
      const title = page.title;

      const pictureUrl = "https://nl.wikipedia.org/w/api.php?action=query&titles=" + title +"&prop=pageimages&format=json&origin=*&pithumbsize=200"
      fetch(pictureUrl).then(response => {
        return response.json();
      }).then(data => {
        console.log(data);
        const page = data.query.pages[Object.keys(data.query.pages)[0]];
        const thumbnailUrl = page.thumbnail.source;
        this.setState({
          wikipediaThumbnailUrl: thumbnailUrl
        })
      }).catch(() => {
        console.log("Could not get thumbnail");
      })

      this.setState({
        information: extract,
        wikipediaReadMoreUrl: "https://nl.wikipedia.org/wiki/" + title,
        foundOnWikipedia: true
      });
    }).catch((e) => {
      this.setState({
        foundOnWikipedia: false
      })
      console.log('An error occured', e);
    });
  }

  onChange = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({
      evaluateInputText: e.currentTarget.value
    })
  }

  componentDidMount() {
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

          <div className="definition-container">
            <div className="definition-title">
              <b>[canonical_name] ([abbreviation])</b>
            </div>
            {/* <div className="definition-source">
              <i>Link naar bron</i>
              <p>... de toetsende partijen zoals <b>Inspectie Leefomgeving en Transport (ILT)</b> en de Regionale Uitvoeringsdiesnt (RUD) moet verder gepland ...</p>
            </div> */}
            <div className="definition">
              <i>Link naar bron</i>
              <p>[description]</p>
            </div>
          </div>

          <div className="linked-data-container">
            <div className="wiki-summary">
              {this.state.foundOnWikipedia == true && <p>{this.state.information}</p>}
              {this.state.foundOnWikipedia == false && <p>Did not find topic on wikipedia.</p>}
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