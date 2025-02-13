# OpenBesluitvorming Search

Search through meeting documents of 320+ Dutch local governments. Powered by
[Open Raadsinformatie](https://github.com/openstate/open-raadsinformatie/).

Check it out at [OpenBesuitvorming.nl](http://openbesluitvorming.nl)!

## Using the ORI API

Check out the
[API docs](https://github.com/openstate/open-raadsinformatie/blob/master/API-docs.md).

## Run front-end

- `pnpm install`
- `pnpm run dev`
- `pnpm run lint`

## Contribution guidelines

Read [contribute.md](/CONTRIBUTE.md)

## Deployment

Netlify tracks the `master` branch and deploys succesful builds to the
[OpenBesluitvorming.nl](https://openbesluitvorming.nl) site.

## Architecture

The [front-end](/front) is a search and browse GUI. It's a typescript react
application that uses
[reactiveserach](https://github.com/appbaseio/reactivesearch) for search
components and [react-pdf](https://github.com/wojtekmaj/react-pdf) to display
PDF files.

## Connecting with Elasticsearch

Make sure ES has the
[correct proxy settings](https://opensource.appbase.io/reactive-manual/getting-started/reactivebase.html#connect-to-elasticsearch).

## Credits

- [VNG Realisatie](https://vngrealisatie.nl) for funding.
- [Open State Foundation](https://openstate.eu/nl/) for providing useful
  feedback on this project and starting Open Raadsinformatie.
- Software developed by [Joep Meindertsma](http://github.com/joepio) from
  [Argu](https://argu.co) / [Ontola](https://ontola.io).
- Feedback from @breyten, @aolieman, @fletcher91, @jurrian
- Various open source projects that we're using, most notably ReactiveSearch and
  Link-Lib. Check out the `package.json` files to see which projects were used.
- [@aolieman](http://github.com/aolieman) and
  [Hendrik](http://github.com/henkieeeee) fpr implementing the Glossary feature
  (select text in PDF to view definition).

<video src="https://user-images.githubusercontent.com/2183313/208661302-385fb00d-5be2-4c50-8159-591c7805e51c.mov"></video>
