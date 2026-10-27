import {createContext, createMemo, createSignal, Show, useContext} from 'solid-js';
import {Lens} from '@habemus-papadum/aiui-viz/site/lens';
import {imageURL, resolveImage, type Block} from '../model/native';
import {pinImage} from '../model/store';
export const ImageAssets = createContext<unknown>([]);

/** Existing Lens supplies hover/focus → peek → click detail; pinning belongs to this study. */
export function ImageContent(props: {image: Partial<Block>; size: 'thumb' | 'preview' | 'full'}) {
  const [failed, setFailed] = createSignal(false);
  const url = () => imageURL(props.image.url);
  return <div class={`history-image-view history-image-${props.size}`} data-state={!url() ? 'unavailable' : failed() ? 'failed' : 'captured'}>
    <Show when={url() && !failed()} fallback={<span class="history-image-missing">▧ {failed() ? 'Image could not load' : 'No captured image bytes'}</span>}>
      <img src={url()} alt={props.image.label || props.image.origin || 'Captured image'} loading="lazy" decoding="async" onError={() => setFailed(true)}/>
    </Show>
    <Show when={props.size !== 'thumb'}><small>{props.image.origin || 'Recorded image'} · {url()?.startsWith('data:') ? 'embedded in history' : url() ? 'exported asset' : 'reference only'}</small>
      <Show when={props.image.qualification}><small>{props.image.qualification}</small></Show>
      <Show when={props.image.reference}><code>{props.image.reference}</code></Show>
    </Show>
  </div>;
}
export function ImageLens(props: {image: Partial<Block>}) {
  const assets = useContext(ImageAssets);
  const image = createMemo(() => resolveImage(props.image, assets));
  return <Lens label={image().label || image().origin || 'Image'} class="history-image-trigger" panelClass="history-image-panel"
    preview={() => <ImageContent image={image()} size="preview"/>}
    detail={() => <div><ImageContent image={image()} size="full"/><button class="history-pin" onClick={() => pinImage.run({...image(), raw: undefined})}>Pin image beside trace</button></div>}>
    <ImageContent image={image()} size="thumb"/><span>{image().origin || 'Image'}</span>
  </Lens>;
}
