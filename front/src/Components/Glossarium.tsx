import * as React from "react";
import Button from "./Button";

interface MState {
  selectedText?: string,
  information?: string
}

interface MProps {}

class Glossarium extends React.PureComponent<MProps, MState> {
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

  onChange = (e:React.FormEvent<HTMLInputElement>) => {
    this.setState({
      selectedText: e.currentTarget.value
    })
  }

  componentDidMount() {
    document.addEventListener('selectionchange', this.updateSelection);
    this.updateSelection();
  }

  updateSelection = () => {
    var sel:Selection = {} as Selection;
    
    var selected = document.getSelection();
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
      <div>
        <div className="Glossarium">
          <h1>Huidige selectie</h1>
          {/* <div className="container__selectedText"> */}
            <input 
              className="selectedText"
              value={this.state.selectedText}
              onChange={this.onChange}></input>
          {/* </div> */}

          <Button
            className="evaluateSelection"
            onClick={this.evaluateSelection}>
              Evaluate
          </Button>

          <h1>Informatie</h1>

          <div className="container">
            {this.state.information}
          </div>
        </div>
      </div>
    );
  }
}


export default Glossarium;