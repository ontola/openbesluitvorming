import * as React from "react";
import Button from "./Button";

interface MState {
  selectedText?: string;
  information?: string;
}

class Glossarium extends React.PureComponent<{}, MState> {
  constructor(props: {}) {
    super(props);
    this.state = {
      selectedText: '',
      information: ''
    }
  }

  evaluateSelection = () => {
    this.setState({
      information: `
      Lorem Ipsum is slechts een proeftekst uit het drukkerij- en zetterijwezen. Lorem Ipsum is de standaard proeftekst in deze bedrijfstak sinds de 16e eeuw, toen een onbekende drukker een zethaak met letters nam en ze door elkaar husselde om een font-catalogus te maken. Het heeft niet alleen vijf eeuwen overleefd maar is ook, vrijwel onveranderd, overgenomen in elektronische letterzetting. Het is in de jaren '60 populair geworden met de introductie van Letraset vellen met Lorem Ipsum passages en meer recentelijk door desktop publishing software zoals Aldus PageMaker die versies van Lorem Ipsum bevatten.
      `
    })
  }

  onChange = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({
      selectedText: e.currentTarget.value
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
        selectedText: sel.toString()
      })
    }
  }


  render() {
    return (
      <div className="Glossarium">
        <div className="glossarium-container">
          <div className="selection-container">
            <h1>Huidige selectie</h1>
            <input 
              className="selected-text"
              value={this.state.selectedText}
              onChange={this.onChange}/>   
            <Button
              className="evaluate-selection-button"
              onClick={this.evaluateSelection}>
                Evaluate
            </Button>
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
              <p>De Inspectie Leefomgeving en Transport (ILT), een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastruc een agentschap van het Ministerie van Infrastructuur en Waterstaat, bewaakt en stimuleert de naleving van wet- en regelgeving voor een veilige en duurzame leefomgeving en transport. Zij is op 1 januari 2012 ontstaan door samenvoeging van de Inspectie Verkeer en Waterstaat (IVW) en de VROM-inspectie nadat beider ministeries waaronder ze vielen werden samengevoegd onder het Kabinet-Rutte I. Het is daarmee een van de Nederlandse rijksinspecties. In 2013 werd het Volkshuisvestelijk Toezicht aan de ILT toegevoegd. In 2014 werden de Kernfysische dienst en het team adviesnetwerken (nucleair) overgeplaatst naar de ANVS. In 2015 werd het Zelfstandig Bestuursorgaan CFW toegevoegd aan de ILT.</p>
              <p className="read-more"><a href="#">Read more</a></p>
            </div>
            <div className="relevant-link">
              <a href="#">http://www.ilent.nl/</a>
            </div>
            <div className="descriptive-image">
              <img className="wiki-image" src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Voertuig_Inspectie_Verkeer_en_Waterstaat_IVW.jpg/260px-Voertuig_Inspectie_Verkeer_en_Waterstaat_IVW.jpg"></img>
            </div>
          </div>
        </div>
      </div>
    );
  }
}


export default Glossarium;